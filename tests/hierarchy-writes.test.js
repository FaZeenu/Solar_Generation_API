const { authenticatedFetch } = require("./helpers/auth");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { randomUUID } = require("node:crypto");
const createApp = require("../app");
const prisma = require("../prisma/client");

test("hierarchy writes and preconditions with temporary rollback-only resources", async t => {
    const rollback = new Error("Intentional hierarchy test rollback");
    const models = ["province", "district", "gridSubstation", "solarInstallation", "generationReading", "user"];
    const counts = async () => Promise.all(models.map(model => prisma[model].count()));
    const before = await counts();
    const suffix = randomUUID();
    try {
        await prisma.$transaction(async tx => {
            const server = createApp(tx).listen(0, "127.0.0.1");
            try {
                await once(server, "listening");
                const base = `http://127.0.0.1:${server.address().port}`;
                async function request(path, method = "GET", body, status = 200, headers = {}) {
                    const response = await authenticatedFetch(base + path, {
                        method, headers: { "Content-Type": "application/json", ...headers },
                        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                    });
                    assert.equal(response.status, status, `${method} ${path}`);
                    const text = await response.text();
                    if (status === 204 || status === 304) {
                        assert.equal(text, ""); return { response, body: null };
                    }
                    assert.match(response.headers.get("content-type"), /application\/json/);
                    const result = JSON.parse(text);
                    if (status >= 400) {
                        assert.deepEqual(Object.keys(result).sort(), ["code", "detail", "message"]);
                        if (status === 409) assert.equal(result.code, "CONFLICT");
                        if (status === 412) assert.equal(result.code, "PRECONDITION_FAILED");
                    }
                    return { response, body: result };
                }
                const resources = [
                    { path: "provinces", model: "province" },
                    { path: "districts", model: "district", parent: "provinceId" },
                    { path: "substations", model: "gridSubstation", parent: "districtId" },
                    { path: "installations", model: "solarInstallation", parent: "substationId" },
                ];
                for (let index = 0; index < resources.length; index++) {
                    const resource = resources[index];
                    const payload = { name: `Temporary ${resource.path} ${suffix}` };
                    if (resource.parent) payload[resource.parent] = resources[index - 1].data.id;
                    if (resource.model === "solarInstallation") payload.meterId = `CRUD-${suffix}`;
                    await t.test(`POST /${resource.path} returns 201 and a retrievable Location`, async () => {
                        const { response, body } = await request(`/${resource.path}`, "POST", payload, 201);
                        resource.data = body;
                        resource.url = `/${resource.path}/${body.id}`;
                        assert.equal(response.headers.get("location"), resource.url);
                        assert.deepEqual((await request(resource.url)).body, body);
                        assert.equal((await request(resource.url)).response.headers.get("etag"), response.headers.get("etag"));
                        assert.equal(response.headers.get("cache-control"), "no-store");
                        assert.match(response.headers.get("vary"), /Accept/);
                    });
                    await t.test(`POST /${resource.path} rejects invalid fields and parent references`, async () => {
                        for (const invalid of [{}, { ...payload, name: " " }, { ...payload, name: 1 }, { ...payload, id: 1 }, { ...payload, children: [] }]) {
                            await request(`/${resource.path}`, "POST", invalid, 400);
                        }
                        if (resource.parent) {
                            await request(`/${resource.path}`, "POST", { ...payload, [resource.parent]: 2147483647 }, 400);
                            await request(`/${resource.path}`, "POST", { ...payload, [resource.parent]: "1" }, 400);
                        }
                        if (resource.model === "solarInstallation") await request(`/${resource.path}`, "POST", { ...payload, meterId: "" }, 400);
                    });
                    await t.test(`PATCH /${resource.path}/:id preserves unsupplied fields and accepts correct If-Match`, async () => {
                        const current = await request(resource.url);
                        resource.oldEtag = current.response.headers.get("etag");
                        const changedName = `${payload.name} updated`;
                        const patched = await request(resource.url, "PATCH", { name: changedName }, 200, { "If-Match": resource.oldEtag });
                        assert.deepEqual(patched.body, { ...current.body, name: changedName });
                        resource.data = patched.body;
                        resource.etag = patched.response.headers.get("etag");
                        assert.notEqual(resource.etag, resource.oldEtag);
                        assert.equal((await request(resource.url)).response.headers.get("etag"), resource.etag);
                        assert.equal((await request(resource.url, "GET", undefined, 304, { "If-None-Match": resource.etag })).body, null);
                    });
                    await t.test(`PATCH and DELETE /${resource.path}/:id reject stale and weak If-Match`, async () => {
                        for (const method of ["PATCH", "DELETE"]) {
                            for (const tag of [resource.oldEtag, `W/${resource.etag}`, '"incorrect"']) {
                                await request(resource.url, method, method === "PATCH" ? { name: "Must not be saved" } : undefined, 412, { "If-Match": tag });
                            }
                        }
                        assert.deepEqual((await request(resource.url)).body, resource.data);
                    });
                    await t.test(`PATCH /${resource.path}/:id rejects invalid and read-only fields`, async () => {
                        for (const body of [{}, { id: resource.data.id }, { name: null }, { name: "" }, { name: false }, { readings: [] }]) await request(resource.url, "PATCH", body, 400);
                        if (resource.parent) await request(resource.url, "PATCH", { [resource.parent]: 2147483647 }, 400);
                        assert.deepEqual((await request(resource.url)).body, resource.data);
                    });
                    await t.test(`PATCH and DELETE /${resource.path}/:id return 404 for nonexistent resources`, async () => {
                        await request(`/${resource.path}/2147483647`, "PATCH", { name: "Missing" }, 404);
                        await request(`/${resource.path}/2147483647`, "DELETE", undefined, 404);
                    });
                }
                const installation = resources[3];
                let reading;
                await t.test("reading ingestion is append-only, with no PATCH or DELETE reading route", async () => {
                    const result = await request(`${installation.url}/readings`, "POST", {
                        timestamp: "2026-01-01T12:00:00+05:30", powerKw: 4, energyKwh: 20, voltage: 230,
                    }, 201);
                    reading = result.body;
                    const location = result.response.headers.get("location");
                    await request(location, "PATCH", { powerKw: 99 }, 404);
                    await request(location, "DELETE", undefined, 404);
                    assert.deepEqual((await request(location)).body, reading);
                    assert.deepEqual((await request(`${installation.url}/last-known-reading`)).body, reading);
                });
                for (const resource of resources) {
                    await t.test(`DELETE /${resource.path}/:id rejects dependent resources with 409`, async () => {
                        await request(resource.url, "DELETE", undefined, 409, { "If-Match": resource.etag });
                        assert.deepEqual((await request(resource.url)).body, resource.data);
                    });
                }
                // Explicit removal of this test-only reading permits checking safe
                // hierarchy deletion; the production API remains append-only.
                await tx.generationReading.delete({ where: { id: reading.id } });
                for (const resource of [...resources].reverse()) {
                    await t.test(`DELETE /${resource.path}/:id with correct If-Match returns empty 204`, async () => {
                        await request(resource.url, "DELETE", undefined, 204, { "If-Match": resource.etag });
                        await request(resource.url, "GET", undefined, 404);
                        await request(resource.url, "DELETE", undefined, 404);
                    });
                }
                await t.test("PATCH and DELETE also work when If-Match is omitted", async () => {
                    const result = await request("/provinces", "POST", { name: `Unconditional ${suffix}` }, 201);
                    const url = result.response.headers.get("location");
                    await request(url, "PATCH", { name: `Unconditional revised ${suffix}` });
                    await request(url, "DELETE", undefined, 204);
                });
                await t.test("If-Match wildcard permits an existing resource", async () => {
                    const result = await request("/provinces", "POST", { name: `Wildcard ${suffix}` }, 201);
                    const url = result.response.headers.get("location");
                    await request(url, "PATCH", { name: `Wildcard revised ${suffix}` }, 200, { "If-Match": "*" });
                    await request(url, "DELETE", undefined, 204, { "If-Match": "*" });
                });
            } finally {
                await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
            }
            throw rollback;
        }, { timeout: 60000 });
    } catch (error) {
        if (error !== rollback) throw error;
    } finally {
        try { assert.deepEqual(await counts(), before, "Permanent table counts must be unchanged"); }
        finally { await prisma.$disconnect(); }
    }
});
