const test = require("node:test");
const assert = require("node:assert/strict");
const { provinces, installations, INTERVAL_MS, START, END, readingsFor } = require("./seed-data");

test("fixtures have 9 provinces, 25 distinct districts and 200 unique installation meters", () => {
    assert.equal(provinces.length, 9);
    assert.equal(new Set(provinces.flatMap(p => p.districts)).size, 25);
    assert.equal(installations.length, 200);
    assert.equal(new Set(installations.map(i => i.meterId)).size, 200);
    assert.equal(new Set(installations.map(i => i.substationName)).size, 25);
});

test("every installation has seven complete days of physically consistent quarter-hour readings", () => {
    let count = 0;
    for (const fixture of installations) {
        const rows = [...readingsFor(fixture, 42)];
        assert.equal(rows.length, 672);
        assert.equal(rows[0].timestamp.getTime(), START.getTime());
        assert.equal(rows.at(-1).timestamp.getTime() + INTERVAL_MS, END.getTime());
        assert.equal(rows[0].energyKwh, 0);
        for (let index = 0; index < rows.length; index++) {
            const row = rows[index];
            const hour = index % 96 / 4;
            assert.equal(row.installationId, 42);
            assert(row.powerKw >= 0 && row.powerKw <= fixture.capacityKw);
            assert(row.voltage >= 220 && row.voltage <= 240);
            if (hour <= 6 || hour >= 18) assert.equal(row.powerKw, 0);
            else assert(row.powerKw > 0);
            if (index > 0) {
                const previous = rows[index - 1];
                assert.equal(row.timestamp - previous.timestamp, INTERVAL_MS);
                assert(row.energyKwh >= previous.energyKwh);
                assert(Math.abs(row.energyKwh - previous.energyKwh - (row.powerKw + previous.powerKw) * 0.125) < 0.000002);
            }
            count++;
        }
        for (let day = 0; day < 7; day++) {
            const offset = day * 96;
            assert(rows[offset + 48].powerKw > rows[offset + 32].powerKw);
            assert(rows[offset + 48].powerKw > rows[offset + 64].powerKw);
            const peak = rows.slice(offset, offset + 96).reduce((best, row, index, dayRows) => row.powerKw > dayRows[best].powerKw ? index : best, 0);
            assert(peak >= 44 && peak <= 52, "Daily peak should occur near noon");
        }
        assert.deepEqual(rows, [...readingsFor(fixture, 42)], "Generation must be deterministic on rerun");
    }
    assert.equal(count, 134400);
});
