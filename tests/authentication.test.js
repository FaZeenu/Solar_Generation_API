const { token } = require("./helpers/auth");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { randomBytes } = require("node:crypto");
const jwt = require("jsonwebtoken");
const createApp = require("../app");
const prisma = require("../prisma/client");

test("JWT authentication and installation/district authorization", async t => {
    const rollback = new Error("Intentional security test rollback");
    const countBefore = await prisma.generationReading.count();
    try {
        await prisma.$transaction(async tx => {
            const rows = await tx.solarInstallation.findMany({ orderBy: { id: "asc" }, include: { substation: true } });
            const own = rows[0];
            const other = rows.find(row => row.substation.districtId !== own.substation.districtId);
            assert(own && other);
            const districtId = own.substation.districtId;
            const device = token({ sub: `installation:${own.id}`, scope: "installation-write", installationId: own.id });
            const analyst = token({ sub: "slsea-test-analyst", scope: "analyst-read-by-district", districtId });
            const admin = token({ sub: "test-administrator", scope: "hierarchy-admin" });
            const server = createApp(tx).listen(0, "127.0.0.1");
            try {
                await once(server, "listening");
                const base = `http://127.0.0.1:${server.address().port}`;
                const ownPath = `/installations/${own.id}`;
                const otherPath = `/installations/${other.id}`;
                const reading = { timestamp: "2030-01-01T12:00:00Z", powerKw: 5, energyKwh: 90, voltage: 230 };
                async function request(path, status, bearer, method = "GET", body) {
                    const response = await fetch(base + path, {
                        method, headers: { "Content-Type": "application/json", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
                        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                    });
                    assert.equal(response.status, status, `${method} ${path}`);
                    if (status === 304) { assert.equal(await response.text(), ""); return { response, body: null }; }
                    assert.match(response.headers.get("content-type"), /application\/json/);
                    const result = await response.json();
                    if (status === 401 || status === 403) {
                        assert.deepEqual(Object.keys(result).sort(), ["code", "detail", "message"]);
                        assert.equal(result.code, status === 401 ? "UNAUTHORIZED" : "FORBIDDEN");
                        if (status === 401) assert.match(response.headers.get("www-authenticate"), /^Bearer/);
                    }
                    return { response, body: result };
                }
                await t.test("missing tokens return 401 on reads and every hierarchy write path", async () => {
                    await request(ownPath, 401);
                    await request(ownPath + "/readings", 401, undefined, "POST", reading);
                    for (const path of ["provinces", "districts", "substations", "installations"]) {
                        await request(`/${path}`, 401, undefined, "POST", {});
                        await request(`/${path}/1`, 401, undefined, "PATCH", {});
                        await request(`/${path}/1`, 401, undefined, "DELETE");
                    }
                });
                await t.test("malformed, wrong-signature, expired and future tokens return 401", async () => {
                    const invalid = [
                        "not-a-jwt",
                        jwt.sign({ sub: "bad", scope: "hierarchy-admin" }, randomBytes(48).toString("hex"), { expiresIn: "1h", issuer: process.env.JWT_ISSUER, audience: process.env.JWT_AUDIENCE }),
                        token({ scope: "hierarchy-admin" }, { expiresIn: -1 }),
                        token({ scope: "hierarchy-admin" }, { notBefore: "1h" }),
                        token({ scope: "hierarchy-admin" }, { issuer: "wrong-issuer" }),
                        token({ scope: "hierarchy-admin" }, { audience: "wrong-audience" }),
                        token({ scope: "hierarchy-admin" }, { algorithm: "HS384" }),
                    ];
                    for (const value of invalid) await request(ownPath, 401, value);
                    const noExpiry = jwt.sign({ sub: "bad", scope: "hierarchy-admin" }, process.env.JWT_SECRET, { issuer: process.env.JWT_ISSUER, audience: process.env.JWT_AUDIENCE });
                    await request(ownPath, 401, noExpiry);
                });
                await t.test("own installation-write token permits POST with 201 and Location", async () => {
                    const result = await request(ownPath + "/readings", 201, device, "POST", reading);
                    assert.equal(result.body.installationId, own.id);
                    assert.equal(result.response.headers.get("location"), `${ownPath}/readings/${result.body.id}`);
                    assert.deepEqual((await request(result.response.headers.get("location"), 200, analyst)).body, result.body);
                });
                await t.test("device token writing to another installation returns 403 without insertion", async () => {
                    const before = await tx.generationReading.count();
                    await request(`/installations/${rows[1].id}/readings`, 403, device, "POST", reading);
                    await request(otherPath + "/readings", 403, device, "POST", reading);
                    assert.equal(await tx.generationReading.count(), before);
                });
                await t.test("case-insensitive and encoded paths cannot bypass authentication or jurisdiction", async () => {
                    const encodedOther = String(other.id).split("").map(character => `%${character.charCodeAt(0).toString(16)}`).join("");
                    await request(`/INSTALLATIONS/${own.id}/READINGS`, 401, undefined, "POST", reading);
                    await request(`/INSTALLATIONS/${other.id}`, 403, analyst);
                    await request(`/installations/${encodedOther}`, 403, analyst);
                    await request(`/installations/${encodedOther}/readings`, 403, device, "POST", reading);
                });
                await t.test("insufficient scopes and invalid scope claims return 403", async () => {
                    await request(ownPath + "/readings", 403, analyst, "POST", reading);
                    await request(ownPath + "/readings", 403, admin, "POST", reading);
                    await request(ownPath + "/readings", 403, token({ scope: "installation-write", installationId: String(own.id) }), "POST", reading);
                    await request(ownPath, 403, device);
                    await request(ownPath, 403, token({ scope: "analyst-read-by-district" }));
                    await request(ownPath, 403, token({ scope: "other" }));
                    await request("/provinces", 403, analyst, "POST", { name: "Must not be created" });
                });
                await t.test("district analyst can read its own installation, composite, latest, history and individual reading", async () => {
                    const latest = await tx.generationReading.findFirst({ where: { installationId: own.id }, orderBy: { timestamp: "desc" } });
                    for (const suffix of ["", "/composite", "/last-known-reading", "/readings", `/readings/${latest.id}`]) await request(ownPath + suffix, 200, analyst);
                    await request(`/substations/${own.substationId}/installations`, 200, analyst);
                });
                await t.test("another district's installation and all derived/scoped paths return 403", async () => {
                    const latest = await tx.generationReading.findFirst({ where: { installationId: other.id } });
                    for (const suffix of ["", "/composite", "/last-known-reading", "/readings", `/readings/${latest.id}`]) await request(otherPath + suffix, 403, analyst);
                    await request(`/substations/${other.substationId}/installations`, 403, analyst);
                });
                await t.test("installation collection count and all pages are restricted to authorized district", async () => {
                    const expected = rows.filter(row => row.substation.districtId === districtId).map(row => row.id);
                    let path = "/installations?limit=3";
                    const actual = [];
                    while (path) {
                        const { body } = await request(path, 200, analyst);
                        assert.equal(body.count, expected.length);
                        actual.push(...body.data.map(row => row.id)); path = body.next;
                    }
                    assert.deepEqual(actual, expected);
                });
                await t.test("explicit cross-jurisdiction filters return 403; own district filter works", async () => {
                    await request(`/installations?districtId=${districtId}`, 200, analyst);
                    await request(`/installations?districtId=${other.substation.districtId}`, 403, analyst);
                    await request(`/installations?substationId=${other.substationId}`, 403, analyst);
                    const district = await tx.district.findUnique({ where: { id: districtId } });
                    const province = await tx.province.findFirst({ where: { id: { not: district.provinceId } } });
                    await request(`/installations?provinceId=${province.id}`, 403, analyst);
                });
                await t.test("authorization precedes conditional GET and caches vary by credentials", async () => {
                    const { response } = await request(ownPath, 200, analyst);
                    assert.match(response.headers.get("vary"), /Authorization/);
                    assert.equal(response.headers.get("cache-control"), "private, no-cache");
                    const denied = await fetch(base + ownPath, { headers: { "If-None-Match": response.headers.get("etag") } });
                    assert.equal(denied.status, 401);
                    const authorized = await fetch(base + ownPath, { headers: { Authorization: `Bearer ${analyst}`, "If-None-Match": response.headers.get("etag") } });
                    assert.equal(authorized.status, 304); assert.equal(await authorized.text(), "");
                });
                await t.test("public geography remains readable without credentials", async () => {
                    await request("/provinces", 200); await request("/districts", 200); await request("/substations", 200);
                });
            } finally {
                await new Promise(resolve => server.close(resolve));
            }
            throw rollback;
        }, { timeout: 60000 });
    } catch (error) {
        if (error !== rollback) throw error;
    } finally {
        try { assert.equal(await prisma.generationReading.count(), countBefore); }
        finally { await prisma.$disconnect(); }
    }
});
