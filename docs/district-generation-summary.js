module.exports = function documentDistrictSummary({ schemas, paths }) {
    const count = description => ({ type: "integer", format: "int32", minimum: 0, description });
    const sourceTime = { type: "string", format: "date-time", nullable: true, description: "UTC source timestamp, or null when no installation has an eligible reading." };
    const example = {
        district: { id: 1, name: "Colombo", provinceId: 1 },
        installationCount: 8, currentTotalPowerKw: 0, todayTotalEnergyKwh: 0,
        coverage: { installationsWithReading: 8, installationsWithoutReading: 0, installationsWithTodayEnergyData: 0, installationsWithMidnightBaseline: 8 },
        context: {
            timezone: "Asia/Colombo", localDate: "2026-10-08",
            dayStart: "2026-10-07T18:30:00.000Z", dayEndExclusive: "2026-10-08T18:30:00.000Z",
            oldestLatestReadingAt: "2026-01-07T18:15:00.000Z", latestReadingAt: "2026-01-07T18:15:00.000Z",
            powerBasis: "Latest timestamp per installation at or before the request; no freshness assumption",
            energyBasis: "Non-negative cumulative counter increments; midnight-crossing intervals prorated by elapsed time; no extrapolation",
        },
    };
    schemas.DistrictGenerationSummary = {
        type: "object", additionalProperties: false,
        required: ["district", "installationCount", "currentTotalPowerKw", "todayTotalEnergyKwh", "coverage", "context"],
        properties: {
            district: { $ref: "#/components/schemas/District" },
            installationCount: count("All installations whose substation belongs to the district, including installations with no readings."),
            currentTotalPowerKw: { type: "number", format: "double", description: "Sum of last-known power (kW) from each installation's newest eligible reading. Rounded to six decimal places; not necessarily live telemetry." },
            todayTotalEnergyKwh: { type: "number", format: "double", minimum: 0, description: "Sum of non-negative cumulative counter increases over today's Sri Lankan day through the request time. Rounded to six decimal places." },
            coverage: {
                type: "object", additionalProperties: false,
                required: ["installationsWithReading", "installationsWithoutReading", "installationsWithTodayEnergyData", "installationsWithMidnightBaseline"],
                properties: {
                    installationsWithReading: count("Installations with at least one reading at or before the request time."),
                    installationsWithoutReading: count("Installation count minus installationsWithReading."),
                    installationsWithTodayEnergyData: count("Installations with at least one observed counter interval ending today; does not guarantee complete day coverage."),
                    installationsWithMidnightBaseline: count("Installations with a reading at or before local midnight, including historical baselines."),
                },
            },
            context: {
                type: "object", additionalProperties: false,
                required: ["timezone", "localDate", "dayStart", "dayEndExclusive", "oldestLatestReadingAt", "latestReadingAt", "powerBasis", "energyBasis"],
                properties: {
                    timezone: { type: "string", enum: ["Asia/Colombo"] },
                    localDate: { type: "string", format: "date", description: "Calendar date of the request in Sri Lanka (+05:30)." },
                    dayStart: { type: "string", format: "date-time", description: "Local midnight expressed as a UTC instant." },
                    dayEndExclusive: { type: "string", format: "date-time", description: "Next local midnight expressed as a UTC instant; the day ends exclusively." },
                    oldestLatestReadingAt: { ...sourceTime, description: "Oldest timestamp among the selected latest readings; null when none exist." },
                    latestReadingAt: { ...sourceTime, description: "Newest timestamp among the selected latest readings; null when none exist." },
                    powerBasis: { type: "string", enum: [example.context.powerBasis] },
                    energyBasis: { type: "string", enum: [example.context.energyBasis] },
                },
            },
        }, example,
    };
    paths["/districts/{districtId}/generation-summary"] = {
        get: {
            summary: "Calculate a district's generation summary",
            description: "Derived processing resource, not a stored aggregate. Current power sums one reading per district installation: timestamp descending, then ID descending, at or before the request time; installations without readings contribute zero. Today's energy uses the latest counter baseline at/before midnight and subsequent samples through the request. It sums non-negative counter increments, prorates midnight-crossing intervals by elapsed time, ignores negative/reset differences, and does not extrapolate missing data or count a first sample without a predecessor. Duplicate timestamps use the highest reading ID. The day is Asia/Colombo (+05:30). Coverage and source timestamps expose incomplete/stale data. An empty district returns zero totals and null source timestamps. Unchanged data and date retain a stable ETag; no volatile calculatedAt field or Last-Modified timestamp is invented. The example shows historical January seed data on a later date: today's energy is zero.",
            parameters: [{ name: "districtId", in: "path", required: true, schema: schemas.District.properties.id, example: 1 }],
            responses: {
                200: { description: "Calculated JSON district summary.", content: { "application/json": { schema: { $ref: "#/components/schemas/DistrictGenerationSummary" }, example } } },
                400: { $ref: "#/components/responses/BadRequest" },
                404: { description: "District does not exist. Jurisdiction authorization is evaluated first: a district-only analyst targeting another district receives 403, including a nonexistent foreign district; an authorized administrator receives 404 for a nonexistent district.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" }, example: { code: "NOT_FOUND", message: "Resource not found", detail: "District not found" } } } },
                406: { $ref: "#/components/responses/NotAcceptable" },
            },
        },
    };
};
