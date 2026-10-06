const { test } = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const express = require("express");
const createApp = require("../app");
const prisma = require("../prisma/client");
const { sendRepresentation, ifMatchSatisfied } = require("../middleware/http-semantics");

function assertError(body, code) {
    assert.deepEqual(Object.keys(body).sort(), ["code", "detail", "message"]);
    assert.equal(body.code, code);
    for (const value of Object.values(body)) assert.equal(typeof value, "string");
}

test("HTTP semantics against seeded resources", async t => {
    const server = createApp(prisma).listen(0, "127.0.0.1");
    t.after(async () => { await new Promise(resolve => server.close(resolve)); await prisma.$disconnect(); });
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = (path, headers = {}) => fetch(base + path, { headers });
    const installation = await prisma.solarInstallation.findFirst({ orderBy: { id: "asc" } });
    const district = await prisma.district.findUnique({ where: { id: (await prisma.gridSubstation.findUnique({ where: { id: installation.substationId } })).districtId } });
    const reading = await prisma.generationReading.findFirst({ where: { installationId: installation.id } });
    const prefix = `/installations/${installation.id}`;
    const paths = [`/provinces/${district.provinceId}`, `/districts/${district.id}`, `/substations/${installation.substationId}`, prefix, `${prefix}/composite`, `${prefix}/last-known-reading`, `${prefix}/readings/${reading.id}`];

    await t.test("errors share code/message/detail for 400, 404 and 406", async () => {
        for (const [path, headers, status, code] of [["/installations?limit=0", {}, 400, "BAD_REQUEST"], ["/missing-route", {}, 404, "NOT_FOUND"], [prefix, { Accept: "text/html" }, 406, "NOT_ACCEPTABLE"]]) {
            const response = await get(path, headers);
            assert.equal(response.status, status); assertError(await response.json(), code);
            assert.match(response.headers.get("content-type"), /application\/json/);
        }
    });
    await t.test("JSON, absent Accept and wildcard media ranges are accepted", async () => {
        for (const Accept of [undefined, "application/json", "*/*", "application/*", "text/html, application/json;q=0.5"]) {
            const response = await get(prefix, Accept ? { Accept } : {});
            assert.equal(response.status, 200);
            assert.match(response.headers.get("content-type"), /application\/json/);
            assert.match(response.headers.get("vary"), /Accept/);
        }
    });
    await t.test("unsupported representations and explicitly excluded JSON return 406", async () => {
        for (const Accept of ["application/xml", "text/html", "application/json;q=0", "application/json;q=0, */*;q=1"]) {
            assert.equal((await get(prefix, { Accept })).status, 406);
        }
    });
    for (const path of paths) {
        await t.test(`stable ETag and empty conditional 304 for ${path}`, async () => {
            const first = await get(path);
            assert.equal(first.status, 200);
            const etag = first.headers.get("etag");
            assert.match(etag, /^"[a-f0-9]{64}"$/);
            assert.equal((await get(path)).headers.get("etag"), etag);
            for (const value of [etag, `W/${etag}`, `"another", ${etag}`, "*"]) {
                const response = await get(path, { "If-None-Match": value });
                assert.equal(response.status, 304);
                assert.equal(await response.text(), "");
                assert.equal(response.headers.get("etag"), etag);
            }
            assert.equal((await get(path, { "If-None-Match": '"outdated"' })).status, 200);
        });
    }
    await t.test("measurement timestamps are not advertised as modification dates", async () => {
        for (const path of paths) {
            const response = await get(path, { "If-Modified-Since": "Wed, 01 Jan 2031 00:00:00 GMT" });
            assert.equal(response.status, 200);
            assert.equal(response.headers.get("last-modified"), null);
        }
    });
    await t.test("If-Match uses strong comparison and errors follow the 412 format", async () => {
        const etag = (await get(prefix)).headers.get("etag");
        assert.equal((await get(prefix, { "If-Match": etag })).status, 200);
        assert.equal((await get(prefix, { "If-Match": "*" })).status, 200);
        for (const value of ['"outdated"', `W/${etag}`]) {
            const response = await get(prefix, { "If-Match": value });
            assert.equal(response.status, 412); assertError(await response.json(), "PRECONDITION_FAILED");
        }
        assert.equal(ifMatchSatisfied("*", etag, false), false);
        assert.equal(ifMatchSatisfied(`"other", ${etag}`, etag), true);
    });
    await t.test("malformed JSON has a safe consistent error", async () => {
        const response = await fetch(base + prefix + "/readings", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"password":"secret",' });
        assert.equal(response.status, 400);
        const body = await response.json(); assertError(body, "BAD_REQUEST");
        assert(!JSON.stringify(body).includes("secret"));
    });
});

test("Last-Modified and If-Modified-Since with reliable modification metadata", async t => {
    // A test-only in-memory representation has a genuine modification date.
    // Production models lack this metadata and intentionally do not supply it.
    const modified = new Date("2025-01-01T12:00:00.900Z");
    const app = express();
    app.get("/fixture", (req, res) => sendRepresentation(req, res, { id: 1 }, modified));
    const server = app.listen(0, "127.0.0.1");
    t.after(() => new Promise(resolve => server.close(resolve)));
    await once(server, "listening");
    const url = `http://127.0.0.1:${server.address().port}/fixture`;
    const first = await fetch(url);
    assert.equal(first.headers.get("last-modified"), "Wed, 01 Jan 2025 12:00:00 GMT");
    const cached = await fetch(url, { headers: { "If-Modified-Since": first.headers.get("last-modified") } });
    assert.equal(cached.status, 304); assert.equal(await cached.text(), "");
    assert.equal(cached.headers.get("last-modified"), first.headers.get("last-modified"));
    for (const value of ["Tue, 31 Dec 2024 12:00:00 GMT", "invalid-date", "2025-01-02"]) {
        assert.equal((await fetch(url, { headers: { "If-Modified-Since": value } })).status, 200);
    }
    assert.equal((await fetch(url, { headers: { "If-None-Match": '"nonmatching"', "If-Modified-Since": "Thu, 02 Jan 2025 12:00:00 GMT" } })).status, 200);
});

test("unexpected database failures do not expose implementation details", async t => {
    const app = createApp({ province: { findUnique: async () => { throw new Error("Prisma postgres://user:password@host database stack trace"); } } });
    const server = app.listen(0, "127.0.0.1");
    t.after(() => new Promise(resolve => server.close(resolve)));
    await once(server, "listening");
    const response = await fetch(`http://127.0.0.1:${server.address().port}/provinces/1`);
    assert.equal(response.status, 500);
    const body = await response.json(); assertError(body, "INTERNAL_SERVER_ERROR");
    assert(!/Prisma|postgres|password|stack/.test(JSON.stringify(body)));
});
