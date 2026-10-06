const assert = require("node:assert/strict");
const prisma = require("./client");
const { provinces, installations, START, END, READINGS_PER_INSTALLATION, readingsFor } = require("./seed-data");

async function verify() {
    const models = ["province", "district", "gridSubstation", "solarInstallation", "generationReading", "user"];
    const counts = Object.fromEntries(await Promise.all(models.map(async model => [model, await prisma[model].count()])));
    console.table(counts);
    assert.equal(counts.province, 9, "Expected exactly 9 provinces");
    assert.equal(counts.district, 25, "Expected exactly 25 districts");
    const districts = await prisma.district.findMany({ include: { province: true } });
    for (const province of provinces) {
        for (const name of province.districts) {
            assert(districts.some(d => d.name === name && d.province.name === province.name), `Missing district ${name}/${province.name}`);
        }
    }
    const rows = await prisma.solarInstallation.findMany({
        where: { meterId: { in: installations.map(i => i.meterId) } },
        include: { substation: { include: { district: true } } },
    });
    assert.equal(rows.length, 200, "Expected 200 seed installations");
    assert.equal(new Set(rows.map(i => i.substationId)).size, 25, "Expected 25 seed substations");
    const byMeter = new Map(rows.map(i => [i.meterId, i]));
    let verified = 0;
    for (const fixture of installations) {
        const installation = byMeter.get(fixture.meterId);
        assert.equal(installation.name, fixture.name);
        assert.equal(installation.substation.name, fixture.substationName);
        assert.equal(installation.substation.district.name, fixture.district);
        const actual = await prisma.generationReading.findMany({
            where: { installationId: installation.id, timestamp: { gte: START, lt: END } },
            orderBy: { timestamp: "asc" },
        });
        assert.equal(actual.length, READINGS_PER_INSTALLATION, `Reading count for ${fixture.meterId}`);
        let index = 0;
        for (const expected of readingsFor(fixture, installation.id)) {
            const reading = actual[index++];
            assert.equal(reading.installationId, expected.installationId);
            assert.equal(reading.timestamp.getTime(), expected.timestamp.getTime(), `Reporting interval for ${fixture.meterId}`);
            for (const key of ["powerKw", "energyKwh", "voltage"]) {
                assert(Number.isFinite(reading[key]) && Math.abs(reading[key] - expected[key]) <= 0.000001,
                    `${fixture.meterId}: incorrect ${key} at ${expected.timestamp.toISOString()}`);
            }
            verified++;
        }
    }
    console.log(`Verified ${verified} seed readings: hierarchy, 15-minute intervals, solar profile, cumulative energy and voltage.`);
    console.log("Counts above include all database records; fixture verification covers the fixed seed window only.");
}

verify().catch(error => {
    console.error("Seed verification failed:", error.message);
    process.exitCode = 1;
}).finally(() => prisma.$disconnect());
