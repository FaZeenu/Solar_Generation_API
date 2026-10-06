const { test } = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const createApp = require("../app");
const prisma = require("../prisma/client");

test("core read API against the seeded database (read-only)", async t => {
    const server = createApp(prisma).listen(0, "127.0.0.1");
    t.after(async () => {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        await prisma.$disconnect();
    });
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    async function get(path, status = 200) {
        const response = await fetch(`${base}${path}`);
        assert.equal(response.status, status, path);
        assert.match(response.headers.get("content-type"), /application\/json/);
        return response.json();
    }
    const resources = [
        { path: "provinces", model: "province", count: 9 },
        { path: "districts", model: "district", count: 25 },
        { path: "substations", model: "gridSubstation", count: 25 },
        { path: "installations", model: "solarInstallation", count: 200 },
    ];
    const collections = {};
    for (const resource of resources) {
        await t.test(`GET /${resource.path} returns the seeded collection`, async () => {
            const expected = await prisma[resource.model].findMany({ orderBy: { id: "asc" } });
            assert.equal(expected.length, resource.count, "Run npm run seed against the development database first");
            const actual = await get(`/${resource.path}`);
            assert.deepEqual(actual, expected);
            collections[resource.path] = actual;
        });
        await t.test(`GET /${resource.path}/:id returns an individual resource`, async () => {
            const row = collections[resource.path][0];
            assert.deepEqual(await get(`/${resource.path}/${row.id}`), row);
            assert(!Object.hasOwn(row, "readings"));
        });
        await t.test(`GET /${resource.path}/:id returns 404 for a missing resource`, async () => {
            const missingId = collections[resource.path].at(-1).id + 1;
            const body = await get(`/${resource.path}/${missingId}`, 404);
            assert.equal(typeof body.error, "string");
        });
        await t.test(`GET /${resource.path}/:id rejects malformed IDs`, async () => {
            for (const id of ["abc", "0", "-1", "1.5", "2147483648", "1e0", "1abc"]) {
                const body = await get(`/${resource.path}/${id}`, 400);
                assert.equal(typeof body.error, "string");
            }
        });
    }
    for (const scope of [
        { parent: "provinces", child: "districts", foreignKey: "provinceId" },
        { parent: "districts", child: "substations", foreignKey: "districtId" },
        { parent: "substations", child: "installations", foreignKey: "substationId" },
    ]) {
        await t.test(`GET /${scope.parent}/:id/${scope.child} scopes every parent correctly`, async () => {
            for (const parent of collections[scope.parent]) {
                const expected = collections[scope.child].filter(child => child[scope.foreignKey] === parent.id);
                const actual = await get(`/${scope.parent}/${parent.id}/${scope.child}`);
                assert.deepEqual(actual, expected);
            }
        });
        await t.test(`GET /${scope.parent}/:id/${scope.child} returns 404 for a missing parent`, async () => {
            const missingId = collections[scope.parent].at(-1).id + 1;
            const body = await get(`/${scope.parent}/${missingId}/${scope.child}`, 404);
            assert.equal(typeof body.error, "string");
        });
    }
    await t.test("unknown routes return JSON 404", async () => {
        assert.deepEqual(await get("/does-not-exist", 404), { error: "Route not found" });
    });
    await t.test("existing root response remains available", async () => {
        const response = await fetch(base);
        assert.equal(response.status, 200);
        assert.equal(await response.text(), "Solar Generation API is running");
    });
});

test("a valid parent with no children returns an empty JSON collection", async t => {
    const client = {
        province: { findUnique: async () => ({ id: 1, name: "Western" }) },
        district: { findMany: async query => {
            assert.deepEqual(query.where, { provinceId: 1 });
            return [];
        } },
    };
    const server = createApp(client).listen(0, "127.0.0.1");
    t.after(() => new Promise(resolve => server.close(resolve)));
    await once(server, "listening");
    const response = await fetch(`http://127.0.0.1:${server.address().port}/provinces/1/districts`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), []);
});
