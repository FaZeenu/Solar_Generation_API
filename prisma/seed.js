const prisma = require("./client");
const { provinces, installations, START, END, readingsFor } = require("./seed-data");

async function seed() {
    return prisma.$transaction(async tx => {
        // Serialize this seed's reruns: the schema intentionally has no reading uniqueness constraint.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(736204901)`;
        const provinceRows = await tx.province.findMany();
        const districtRows = await tx.district.findMany({ include: { province: true } });
        for (const row of provinceRows) {
            if (!provinces.some(p => p.name === row.name)) {
                throw new Error(`Unexpected province "${row.name}". Resolve it manually; seed will not delete data.`);
            }
        }
        for (const row of districtRows) {
            if (!provinces.some(p => p.name === row.province.name && p.districts.includes(row.name))) {
                throw new Error(`Unexpected district/province pair: ${row.name}/${row.province.name}. Seed will not delete data.`);
            }
        }

        await tx.province.createMany({ data: provinces.map(p => ({ name: p.name })), skipDuplicates: true });
        const provinceIds = new Map((await tx.province.findMany()).map(p => [p.name, p.id]));
        await tx.district.createMany({
            data: provinces.flatMap(p => p.districts.map(name => ({ name, provinceId: provinceIds.get(p.name) }))),
            skipDuplicates: true,
        });
        const districtIds = new Map((await tx.district.findMany()).map(d => [d.name, d.id]));
        await tx.gridSubstation.createMany({
            data: [...districtIds].map(([name, id]) => ({ name: `Demo ${name} Grid Substation`, districtId: id })),
            skipDuplicates: true,
        });
        const substations = await tx.gridSubstation.findMany();
        const substationIdFor = fixture => substations.find(s =>
            s.name === fixture.substationName && s.districtId === districtIds.get(fixture.district)).id;
        await tx.solarInstallation.createMany({
            data: installations.map(i => ({ name: i.name, meterId: i.meterId, substationId: substationIdFor(i) })),
            skipDuplicates: true,
        });
        const seeded = await tx.solarInstallation.findMany({ where: { meterId: { in: installations.map(i => i.meterId) } } });
        const byMeter = new Map(seeded.map(i => [i.meterId, i]));
        let inserted = 0;
        let retained = 0;
        let batch = [];
        const flush = async () => {
            if (!batch.length) return;
            inserted += (await tx.generationReading.createMany({ data: batch })).count;
            batch = [];
        };
        for (const fixture of installations) {
            const installation = byMeter.get(fixture.meterId);
            if (installation.name !== fixture.name || installation.substationId !== substationIdFor(fixture)) {
                throw new Error(`Seed meter ${fixture.meterId} already belongs to a conflicting installation.`);
            }
            const existing = await tx.generationReading.findMany({
                where: { installationId: installation.id, timestamp: { gte: START, lt: END } },
            });
            const byTime = new Map(existing.map(r => [r.timestamp.getTime(), r]));
            if (byTime.size !== existing.length) throw new Error(`Duplicate readings for ${fixture.meterId}; no records were deleted.`);
            for (const reading of readingsFor(fixture, installation.id)) {
                const previous = byTime.get(reading.timestamp.getTime());
                if (previous) {
                    if (["powerKw", "energyKwh", "voltage"].some(key => Math.abs(previous[key] - reading[key]) > 0.000001)) {
                        throw new Error(`Conflicting reading for ${fixture.meterId} at ${reading.timestamp.toISOString()}.`);
                    }
                    byTime.delete(reading.timestamp.getTime());
                    retained++;
                } else {
                    batch.push(reading);
                    if (batch.length >= 2000) await flush();
                }
            }
            if (byTime.size) throw new Error(`Off-interval readings found for ${fixture.meterId}.`);
        }
        await flush();
        return { inserted, retained };
    }, { maxWait: 10000, timeout: 180000 });
}

seed().then(result => {
    console.log(`Seed complete: ${result.inserted} readings inserted; ${result.retained} existing readings preserved.`);
    console.log("Fixture: 9 provinces, 25 districts, 25 demo substations, 200 installations, 134400 readings.");
}).catch(error => {
    console.error("Seed failed; transaction rolled back:", error.message);
    process.exitCode = 1;
}).finally(() => prisma.$disconnect());
