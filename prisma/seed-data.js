// Synthetic development fixtures, not measurements or an official substation inventory.
const provinces = [
    { name: "Western", districts: ["Colombo", "Gampaha", "Kalutara"] },
    { name: "Central", districts: ["Kandy", "Matale", "Nuwara Eliya"] },
    { name: "Southern", districts: ["Galle", "Matara", "Hambantota"] },
    { name: "Northern", districts: ["Jaffna", "Kilinochchi", "Mannar", "Vavuniya", "Mullaitivu"] },
    { name: "Eastern", districts: ["Batticaloa", "Ampara", "Trincomalee"] },
    { name: "North Western", districts: ["Kurunegala", "Puttalam"] },
    { name: "North Central", districts: ["Anuradhapura", "Polonnaruwa"] },
    { name: "Uva", districts: ["Badulla", "Moneragala"] },
    { name: "Sabaragamuwa", districts: ["Ratnapura", "Kegalle"] },
];

const INTERVAL_MS = 15 * 60 * 1000;
const DAYS = 7;
const READINGS_PER_INSTALLATION = DAYS * 24 * 4;
// Fixed window makes reruns independent of the current date and machine timezone.
const START = new Date("2026-01-01T00:00:00+05:30");
const END = new Date(START.getTime() + READINGS_PER_INSTALLATION * INTERVAL_MS);
const installations = provinces.flatMap(province => province.districts).flatMap((district, districtIndex) =>
    Array.from({ length: 8 }, (_, index) => ({
        name: `Demo ${district} Solar ${index + 1}`,
        meterId: `SEED-LK-${String(districtIndex + 1).padStart(2, "0")}-${String(index + 1).padStart(3, "0")}`,
        district,
        substationName: `Demo ${district} Grid Substation`,
        capacityKw: 3 + ((districtIndex * 8 + index) % 18),
        ordinal: districtIndex * 8 + index,
    }))
);

const round = value => Math.round(value * 1000000) / 1000000;

function* readingsFor(installation, installationId) {
    let energyKwh = 0;
    let previousPower = 0;
    for (let index = 0; index < READINGS_PER_INSTALLATION; index++) {
        const day = Math.floor(index / 96);
        const hour = (index % 96) / 4;
        const daylight = hour > 6 && hour < 18;
        // Smooth sunrise-to-sunset profile with deterministic daily cloud variation.
        const weather = 0.72 + 0.04 * ((installation.ordinal + day * 3) % 7);
        const cloud = 0.96 + 0.04 * Math.cos((hour - 12) * 0.7 + installation.ordinal);
        const powerKw = daylight
            ? round(installation.capacityKw * Math.sin(Math.PI * (hour - 6) / 12) ** 1.6 * weather * cloud)
            : 0;
        // Trapezoidal integration of kW over the elapsed quarter-hour gives kWh.
        if (index > 0) energyKwh += (previousPower + powerKw) / 2 * 0.25;
        previousPower = powerKw;
        yield {
            installationId,
            timestamp: new Date(START.getTime() + index * INTERVAL_MS),
            powerKw,
            energyKwh: round(energyKwh),
            // Grid-connected meter voltage remains near 230 V even overnight.
            voltage: round(230 + 3 * Math.sin(index * 0.17 + installation.ordinal) + 4 * powerKw / installation.capacityKw),
        };
    }
}

module.exports = { provinces, installations, INTERVAL_MS, DAYS, READINGS_PER_INSTALLATION, START, END, readingsFor };
