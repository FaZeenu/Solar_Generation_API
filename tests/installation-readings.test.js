const { authenticatedFetch } = require("./helpers/auth");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { randomUUID } = require("node:crypto");
const createApp = require("../app");
const prisma = require("../prisma/client");
const json = value => JSON.parse(JSON.stringify(value));

test("installation composite and reading API (transaction rolled back after tests)", async t => {
    const rollback = new Error("Intentional test rollback");
    const countBefore = await prisma.generationReading.count();
    try {
        await prisma.$transaction(async tx => {
            const installation = await tx.solarInstallation.findFirst({ orderBy: { id: "asc" } });
            assert(installation, "Run the seed first");
            const empty = await tx.solarInstallation.create({ data: {
                name: "Temporary reading API test", meterId: `TEST-${randomUUID()}`, substationId: installation.substationId,
            } });
            const server = createApp(tx).listen(0, "127.0.0.1");
            try {
                await once(server, "listening");
                const base = `http://127.0.0.1:${server.address().port}`;
                const path = `/installations/${installation.id}`;
                const latestOrder = [{ timestamp: "desc" }, { id: "desc" }];
                async function request(url, status = 200, options) {
                    const response = await authenticatedFetch(`${base}${url}`, options);
                    assert.equal(response.status, status, url);
                    assert.match(response.headers.get("content-type"), /application\/json/);
                    return { response, body: await response.json() };
                }
                const payload = { timestamp: "2030-01-01T12:00:00+05:30", powerKw: 4.5, energyKwh: 123.75, voltage: 231.2 };
                const post = body => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

                await t.test("composite contains substation, district, province and one latest reading", async () => {
                    const expected = await tx.solarInstallation.findUnique({ where: { id: installation.id }, include: {
                        substation: { include: { district: { include: { province: true } } } },
                        readings: { take: 1, orderBy: latestOrder },
                    } });
                    const { readings, ...resource } = expected;
                    const { body } = await request(`${path}/composite`);
                    assert.deepEqual(body, json({ ...resource, latestReading: readings[0] }));
                    assert(!Object.hasOwn(body, "readings"));
                });
                await t.test("last-known-reading returns latest seeded timestamp", async () => {
                    const expected = await tx.generationReading.findFirst({ where: { installationId: installation.id }, orderBy: latestOrder });
                    assert.deepEqual((await request(`${path}/last-known-reading`)).body, json(expected));
                });
                await t.test("history contains only this installation's readings", async () => {
                    const expected = await tx.generationReading.findMany({ where: { installationId: installation.id }, orderBy: [{ timestamp: "asc" }, { id: "asc" }] });
                    assert.equal(expected.length, 672);
                    const received = [];
                    let url = `${path}/readings`;
                    while (url) {
                        const { body } = await request(url);
                        assert.equal(body.count, expected.length);
                        received.push(...body.data);
                        url = body.next;
                    }
                    assert.deepEqual(received, json(expected));
                });
                await t.test("individual reading is returned and wrong installation is rejected", async () => {
                    const reading = await tx.generationReading.findFirst({ where: { installationId: installation.id } });
                    assert.deepEqual((await request(`${path}/readings/${reading.id}`)).body, json(reading));
                    await request(`/installations/${empty.id}/readings/${reading.id}`, 404);
                });
                await t.test("POST returns 201, correct resource and a Location that resolves to it", async () => {
                    const { response, body } = await request(`${path}/readings`, 201, post(payload));
                    assert.equal(body.installationId, installation.id);
                    assert.equal(body.timestamp, new Date(payload.timestamp).toISOString());
                    for (const field of ["powerKw", "energyKwh", "voltage"]) assert.equal(body[field], payload[field]);
                    const location = response.headers.get("location");
                    assert.equal(location, `${path}/readings/${body.id}`);
                    assert.deepEqual((await request(location)).body, body);
                });
                await t.test("latest uses timestamp, not highest reading ID, after out-of-order ingestion", async () => {
                    const { body: older } = await request(`${path}/readings`, 201, post({ ...payload, timestamp: "2029-01-01T12:00:00Z" }));
                    const { body: newest } = await request(`${path}/last-known-reading`);
                    assert(newest.id < older.id);
                    assert.equal(newest.timestamp, new Date(payload.timestamp).toISOString());
                    assert.deepEqual((await request(`${path}/composite`)).body.latestReading, newest);
                });
                await t.test("matching body installationId is accepted", async () => {
                    const { body } = await request(`${path}/readings`, 201, post({ ...payload, installationId: installation.id }));
                    assert.equal(body.installationId, installation.id);
                });
                await t.test("invalid inputs and conflicting installationId return 400 without inserting", async () => {
                    const before = await tx.generationReading.count();
                    const invalid = [null, [], {}, { ...payload, powerKw: "4.5" }, { ...payload, energyKwh: -1 },
                        { ...payload, voltage: null }, { ...payload, timestamp: "invalid" },
                        { ...payload, timestamp: "2030-02-30T12:00:00Z" },
                        { ...payload, timestamp: "2030-01-01T12:00:00" },
                        { ...payload, installationId: empty.id }, { ...payload, id: 123 }];
                    for (const field of ["timestamp", "powerKw", "energyKwh", "voltage"]) {
                        const body = { ...payload }; delete body[field]; invalid.push(body);
                    }
                    for (const body of invalid) await request(`${path}/readings`, 400, post(body));
                    await request(`${path}/readings`, 400, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"broken":' });
                    assert.equal(await tx.generationReading.count(), before);
                });
                await t.test("all routes return 404 for a nonexistent installation", async () => {
                    const missing = (await tx.solarInstallation.findFirst({ orderBy: { id: "desc" } })).id + 1;
                    for (const suffix of ["composite", "last-known-reading", "readings", "readings/1"]) await request(`/installations/${missing}/${suffix}`, 404);
                    await request(`/installations/${missing}/readings`, 404, post(payload));
                });
                await t.test("empty installation has no last reading, empty history and composite latestReading null", async () => {
                    const emptyPath = `/installations/${empty.id}`;
                    await request(`${emptyPath}/last-known-reading`, 404);
                    const history = (await request(`${emptyPath}/readings`)).body;
                    assert.deepEqual(history.data, []);
                    assert.equal(history.count, 0);
                    assert.equal((await request(`${emptyPath}/composite`)).body.latestReading, null);
                });
                await t.test("missing reading returns 404 and malformed IDs return 400", async () => {
                    const missing = (await tx.generationReading.findFirst({ orderBy: { id: "desc" } })).id + 1;
                    await request(`${path}/readings/${missing}`, 404);
                    await request(`${path}/readings/abc`, 400);
                    await request("/installations/abc/composite", 400);
                });
            } finally {
                await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
            }
            throw rollback;
        }, { timeout: 60000 });
    } catch (error) {
        if (error !== rollback) throw error;
    } finally {
        try {
            assert.equal(await prisma.generationReading.count(), countBefore, "Test readings must be rolled back");
            assert.equal(await prisma.solarInstallation.count({ where: { meterId: { startsWith: "TEST-" } } }), 0);
        } finally {
            await prisma.$disconnect();
        }
    }
});
