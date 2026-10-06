const { test } = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const createApp = require("../app");
const prisma = require("../prisma/client");

test("pagination, hierarchy filters and timestamp queries against seeded PostgreSQL", async t => {
    const server = createApp(prisma).listen(0, "127.0.0.1");
    t.after(async () => {
        await new Promise(resolve => server.close(resolve));
        await prisma.$disconnect();
    });
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    async function get(path, status = 200) {
        const response = await fetch(base + path);
        assert.equal(response.status, status, path);
        assert.match(response.headers.get("content-type"), /application\/json/);
        return response.json();
    }
    const installations = await prisma.solarInstallation.findMany({ orderBy: { id: "asc" }, include: { substation: { include: { district: true } } } });
    assert.equal(installations.length, 200);
    const first = installations[0];
    const scalar = row => { const { substation, ...fields } = row; return fields; };
    const path = `/installations/${first.id}/readings`;
    const readings = JSON.parse(JSON.stringify(await prisma.generationReading.findMany({ where: { installationId: first.id }, orderBy: [{ timestamp: "asc" }, { id: "asc" }] })));
    assert.equal(readings.length, 672);
    const from = readings[96].timestamp;
    const to = readings[191].timestamp;
    const range = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

    await t.test("default pagination bounds installations and readings to 20", async () => {
        for (const url of ["/installations", path]) {
            const body = await get(url);
            assert.equal(body.page, 1); assert.equal(body.limit, 20); assert.equal(body.data.length, 20);
        }
    });
    await t.test("custom page and limit return the requested slice", async () => {
        assert.deepEqual((await get("/installations?page=2&limit=7")).data, installations.slice(7, 14).map(scalar));
        assert.deepEqual((await get(`${path}?page=3&limit=9`)).data, readings.slice(18, 27));
    });
    await t.test("count represents all matching resources rather than current page size", async () => {
        assert.equal((await get("/installations?limit=3")).count, 200);
        assert.equal((await get(`${path}?limit=3`)).count, 672);
    });
    await t.test("next link identifies the next page", async () => {
        const body = await get("/installations?limit=7");
        assert.deepEqual((await get(body.next)).data, installations.slice(7, 14).map(scalar));
    });
    await t.test("previous link identifies the preceding page", async () => {
        const body = await get(`${path}?page=2&limit=7`);
        assert.deepEqual((await get(body.previous)).data, readings.slice(0, 7));
    });
    await t.test("first page has no previous", async () => {
        assert.equal((await get("/installations")).previous, null);
        assert.equal((await get(path)).previous, null);
    });
    await t.test("last page has no next", async () => {
        const body = await get("/installations?page=10&limit=20");
        assert.equal(body.next, null); assert.equal(body.data.length, 20);
        const last = await get(`${path}?page=34&limit=20`);
        assert.equal(last.next, null); assert.equal(last.data.length, 12);
    });
    await t.test("invalid and repeated page/limit parameters return 400", async () => {
        for (const url of ["/installations", path]) {
            for (const query of ["page=0", "page=-1", "page=1.5", "page=abc", "page=", "page=1&page=2", "page=2147483647&limit=100", "limit=0", "limit=-1", "limit=abc", "limit=101", "limit=2.5", "limit=1&limit=2"]) await get(`${url}?${query}`, 400);
        }
    });
    for (const [name, id, predicate] of [
        ["provinceId", first.substation.district.provinceId, row => row.substation.district.provinceId === first.substation.district.provinceId],
        ["districtId", first.substation.districtId, row => row.substation.districtId === first.substation.districtId],
        ["substationId", first.substationId, row => row.substationId === first.substationId],
    ]) {
        await t.test(`${name} filters installations and count`, async () => {
            const expected = installations.filter(predicate).map(scalar);
            const body = await get(`/installations?${name}=${id}&limit=100`);
            assert.deepEqual(body.data, expected); assert.equal(body.count, expected.length);
        });
    }
    await t.test("all hierarchy filters combine with pagination and navigation links", async () => {
        const query = `provinceId=${first.substation.district.provinceId}&districtId=${first.substation.districtId}&substationId=${first.substationId}&limit=3`;
        const expected = installations.filter(row => row.substationId === first.substationId).map(scalar);
        const page1 = await get(`/installations?${query}`);
        assert.equal(page1.count, expected.length); assert.deepEqual(page1.data, expected.slice(0, 3));
        const page2 = await get(page1.next);
        assert.equal(page2.count, expected.length); assert.deepEqual(page2.data, expected.slice(3, 6));
        assert.deepEqual((await get(page2.previous)).data, page1.data);
    });
    await t.test("scoped installations stay within their parent even with conflicting filters", async () => {
        const other = installations.find(row => row.substationId !== first.substationId);
        const result = await get(`/substations/${first.substationId}/installations?substationId=${other.substationId}`);
        assert.equal(result.count, 0); assert.deepEqual(result.data, []); assert.equal(result.next, null);
    });
    await t.test("invalid hierarchy IDs return 400 and nonexistent IDs yield empty results", async () => {
        for (const name of ["provinceId", "districtId", "substationId"]) {
            for (const value of ["abc", "0", "-1", "1.5", "2147483648"]) await get(`/installations?${name}=${value}`, 400);
        }
        const body = await get("/installations?provinceId=2147483647");
        assert.equal(body.count, 0); assert.deepEqual(body.data, []);
    });
    await t.test("from filtering is inclusive", async () => {
        const body = await get(`${path}?from=${encodeURIComponent(from)}`);
        assert.equal(body.count, 576); assert.deepEqual(body.data, readings.slice(96, 116));
    });
    await t.test("to filtering is inclusive", async () => {
        const body = await get(`${path}?to=${encodeURIComponent(to)}`);
        assert.equal(body.count, 192); assert.deepEqual(body.data, readings.slice(0, 20));
    });
    await t.test("combined date range has correct filtered total", async () => {
        const body = await get(`${path}?${range}&limit=100`);
        assert.equal(body.count, 96); assert.deepEqual(body.data, readings.slice(96, 192));
    });
    await t.test("ascending timestamp sorting", async () => {
        assert.deepEqual((await get(`${path}?sort=asc`)).data, readings.slice(0, 20));
    });
    await t.test("descending timestamp sorting", async () => {
        assert.deepEqual((await get(`${path}?sort=desc`)).data, [...readings].reverse().slice(0, 20));
    });
    await t.test("date range, descending sort and pagination combine; links preserve the query", async () => {
        const expected = readings.slice(96, 192).reverse();
        const body = await get(`${path}?${range}&sort=desc&page=2&limit=10`);
        assert.equal(body.count, 96); assert.deepEqual(body.data, expected.slice(10, 20));
        assert.deepEqual((await get(body.next)).data, expected.slice(20, 30));
        assert.deepEqual((await get(body.previous)).data, expected.slice(0, 10));
        const offset = "2026-01-02T00:00:00+05:30";
        const local = await get(`${path}?from=${encodeURIComponent(offset)}&limit=1`);
        assert.equal(local.data[0].timestamp, new Date(offset).toISOString());
    });
    await t.test("invalid timestamps return 400", async () => {
        for (const name of ["from", "to"]) {
            for (const value of ["broken", "2026-02-30T12:00:00Z", "2026-01-02T00:00:00", "2026-01-02T24:00:00Z", ""]) await get(`${path}?${name}=${encodeURIComponent(value)}`, 400);
        }
        await get(`${path}?from=${encodeURIComponent(from)}&from=${encodeURIComponent(to)}`, 400);
    });
    await t.test("from later than to returns 400", async () => {
        await get(`${path}?from=${encodeURIComponent(to)}&to=${encodeURIComponent(from)}`, 400);
    });
    await t.test("equal timestamp bounds return one reading", async () => {
        const body = await get(`${path}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(from)}`);
        assert.equal(body.count, 1); assert.deepEqual(body.data, [readings[96]]);
    });
    await t.test("unsupported and repeated sort values return 400", async () => {
        for (const query of ["sort=invalid", "sort=ASC", "sort=", "sort=asc&sort=desc"]) await get(`${path}?${query}`, 400);
    });
    await t.test("out-of-range pages return empty data with unchanged total", async () => {
        const body = await get("/installations?page=11");
        assert.equal(body.count, 200); assert.deepEqual(body.data, []); assert.equal(body.next, null); assert(body.previous);
    });
});
