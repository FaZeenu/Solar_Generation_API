const { token } = require("./helpers/auth");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { randomUUID } = require("node:crypto");
const createApp = require("../app");
const prisma = require("../prisma/client");

test("derived district generation summary with rollback-only fixtures", async t => {
    const models = ["province", "district", "gridSubstation", "solarInstallation", "generationReading", "user"];
    const counts = async () => Promise.all(models.map(model => prisma[model].count()));
    const before = await counts();
    const rollback = new Error("Intentional summary test rollback");
    try {
        await prisma.$transaction(async tx => {
            const suffix = randomUUID();
            const province = await tx.province.findFirst();
            const district = await tx.district.create({ data: { name: `Summary ${suffix}`, provinceId: province.id } });
            const otherDistrict = await tx.district.create({ data: { name: `Other summary ${suffix}`, provinceId: province.id } });
            const emptyDistrict = await tx.district.create({ data: { name: `Empty summary ${suffix}`, provinceId: province.id } });
            const substation = await tx.gridSubstation.create({ data: { name: "Summary fixture", districtId: district.id } });
            const otherSubstation = await tx.gridSubstation.create({ data: { name: "Other fixture", districtId: otherDistrict.id } });
            const installations = [];
            for (let index = 0; index < 4; index++) {
                installations.push(await tx.solarInstallation.create({ data: {
                    name: `Summary installation ${index}`, meterId: `SUMMARY-${suffix}-${index}`, substationId: index < 3 ? substation.id : otherSubstation.id,
                } }));
            }
            const now = Date.now();
            const localDate = new Date(now + 19800000).toISOString().slice(0, 10);
            const midnight = Date.parse(`${localDate}T00:00:00+05:30`);
            const elapsed = now - midnight;
            assert(elapsed > 10, "Test must not start exactly at local midnight");
            const middle = midnight + Math.floor(elapsed / 2);
            const late = now - 2;
            const firstB = midnight + Math.floor(elapsed / 4);
            const row = (index, timestamp, energyKwh, powerKw) => ({ installationId: installations[index].id, timestamp: new Date(timestamp), energyKwh, powerKw, voltage: 230 });
            await tx.generationReading.createMany({ data: [
                row(0, midnight - 900000, 99, 8), row(0, midnight, 100, 0),
                row(0, late, 106, 4), row(0, middle, 102, 2),
                row(1, midnight - 3600000, 50, 20), row(1, firstB, 54, 3), row(1, late, 59, 6),
                row(3, late, 9000, 1000),
                // Future data must not be treated as current telemetry.
                row(0, now + 86400000, 10000, 999),
            ] });
            const expectedEnergy = 11 + 4 * (firstB - midnight) / (firstB - (midnight - 3600000));
            const analyst = token({ sub: "summary-analyst", scope: "analyst-read-by-district", districtId: district.id });
            const admin = token({ scope: "hierarchy-admin" });
            const path = `/districts/${district.id}/generation-summary`;
            const server = createApp(tx).listen(0, "127.0.0.1");
            try {
                await once(server, "listening");
                const base = `http://127.0.0.1:${server.address().port}`;
                async function get(url, status = 200, bearer = analyst, headers = {}) {
                    const response = await fetch(base + url, { headers: { ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...headers } });
                    assert.equal(response.status, status, url);
                    if (status === 304) { assert.equal(await response.text(), ""); return { response }; }
                    assert.match(response.headers.get("content-type"), /application\/json/);
                    const body = await response.json();
                    if (status >= 400) assert.deepEqual(Object.keys(body).sort(), ["code", "detail", "message"]);
                    return { response, body };
                }
                await t.test("valid summary identifies district and reports installation/data coverage", async () => {
                    const { body } = await get(path);
                    assert.deepEqual(body.district, { id: district.id, name: district.name, provinceId: province.id });
                    assert.equal(body.installationCount, 3);
                    assert.deepEqual(body.coverage, {
                        installationsWithReading: 2, installationsWithoutReading: 1,
                        installationsWithTodayEnergyData: 2, installationsWithMidnightBaseline: 2,
                    });
                    assert.equal(body.context.timezone, "Asia/Colombo");
                    assert.equal(body.context.localDate, localDate);
                    assert.equal(body.context.dayStart, new Date(midnight).toISOString());
                    assert.equal(body.context.dayEndExclusive, new Date(midnight + 86400000).toISOString());
                    assert.equal(body.context.latestReadingAt, new Date(late).toISOString());
                });
                await t.test("current power uses one latest timestamp per installation and excludes other districts/future data", async () => {
                    assert.equal((await get(path)).body.currentTotalPowerKw, 10);
                });
                await t.test("today energy uses cumulative increments and prorates the midnight-crossing interval", async () => {
                    assert(Math.abs((await get(path)).body.todayTotalEnergyKwh - expectedEnergy) <= 0.000001);
                });
                await t.test("nonexistent district returns JSON 404 for an authorized administrator", async () => {
                    assert.equal((await get("/districts/2147483647/generation-summary", 404, admin)).body.code, "NOT_FOUND");
                });
                await t.test("own district analyst is authorized and another district is forbidden", async () => {
                    await get(path);
                    await get(`/districts/${otherDistrict.id}/generation-summary`, 403);
                });
                await t.test("missing token returns 401 and insufficient scope returns 403", async () => {
                    await get(path, 401, null);
                    await get(path, 403, token({ scope: "installation-write", installationId: installations[0].id }));
                });
                await t.test("case-varied and encoded district URLs cannot bypass jurisdiction", async () => {
                    const encoded = String(otherDistrict.id).split("").map(c => `%${c.charCodeAt(0).toString(16)}`).join("");
                    await get(`/DISTRICTS/${otherDistrict.id}/GENERATION-SUMMARY`, 403);
                    await get(`/districts/${encoded}/generation-summary`, 403);
                });
                await t.test("stable ETag supports empty 304 after authorization", async () => {
                    const first = await get(path);
                    const etag = first.response.headers.get("etag");
                    assert(etag); assert.equal((await get(path)).response.headers.get("etag"), etag);
                    assert.equal(first.response.headers.get("cache-control"), "private, no-cache");
                    assert.match(first.response.headers.get("vary"), /Authorization/);
                    await get(path, 304, analyst, { "If-None-Match": etag });
                    await get(`/districts/${otherDistrict.id}/generation-summary`, 403, analyst, { "If-None-Match": "*" });
                });
                await t.test("empty district returns zero totals and null source timestamps", async () => {
                    const { body } = await get(`/districts/${emptyDistrict.id}/generation-summary`, 200, admin);
                    assert.equal(body.installationCount, 0); assert.equal(body.currentTotalPowerKw, 0); assert.equal(body.todayTotalEnergyKwh, 0);
                    assert.equal(body.context.latestReadingAt, null);
                });
                await t.test("historical seed has no energy today and remains visible with source age", async () => {
                    const seeded = await tx.district.findFirst({ where: { name: "Colombo" } });
                    const { body } = await get(`/districts/${seeded.id}/generation-summary`, 200, admin);
                    assert.equal(body.installationCount, 8);
                    assert.equal(body.todayTotalEnergyKwh, 0);
                    assert.equal(body.coverage.installationsWithTodayEnergyData, 0);
                    assert(body.context.latestReadingAt.startsWith("2026-01-07"));
                });
                await t.test("invalid district ID returns 400 and unsupported Accept returns 406", async () => {
                    await get("/districts/abc/generation-summary", 400, admin);
                    await get(path, 406, analyst, { Accept: "text/html" });
                });
            } finally {
                await new Promise(resolve => server.close(resolve));
            }
            throw rollback;
        }, { timeout: 60000 });
    } catch (error) {
        if (error !== rollback) throw error;
    } finally {
        try { assert.deepEqual(await counts(), before, "Permanent database counts must remain unchanged"); }
        finally { await prisma.$disconnect(); }
    }
});
