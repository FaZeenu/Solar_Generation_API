const COLOMBO_OFFSET_MS = 330 * 60 * 1000;

function sriLankanDay(asOf) {
    const localDate = new Date(asOf.getTime() + COLOMBO_OFFSET_MS).toISOString().slice(0, 10);
    const start = new Date(`${localDate}T00:00:00+05:30`);
    return { localDate, start, end: new Date(start.getTime() + 86400000) };
}

function districtGenerationSummary(prisma) {
    return async (req, res) => {
        const district = res.locals.resource;
        const asOf = new Date();
        const { localDate, start, end } = sriLankanDay(asOf);
        // One statement gives a consistent database snapshot. Lateral queries
        // use the existing installation/timestamp index and avoid full history transfer.
        const [summary] = await prisma.$queryRaw`
            WITH installations AS (
                SELECT i.id FROM "SolarInstallation" i
                JOIN "GridSubstation" s ON s.id = i."substationId"
                WHERE s."districtId" = ${district.id}
            )
            SELECT COUNT(*)::int AS "installationCount",
                COUNT(latest.timestamp)::int AS "installationsWithReading",
                COALESCE(SUM(latest."powerKw"), 0)::float8 AS "currentTotalPowerKw",
                COALESCE(SUM(energy.total), 0)::float8 AS "todayTotalEnergyKwh",
                COUNT(*) FILTER (WHERE energy.intervals > 0)::int AS "installationsWithTodayEnergyData",
                COUNT(*) FILTER (WHERE energy.baseline)::int AS "installationsWithMidnightBaseline",
                MIN(latest.timestamp) AS "oldestLatestReadingAt",
                MAX(latest.timestamp) AS "latestReadingAt"
            FROM installations i
            LEFT JOIN LATERAL (
                SELECT r.timestamp, r."powerKw" FROM "GenerationReading" r
                WHERE r."installationId" = i.id AND r.timestamp <= ${asOf}::timestamp
                ORDER BY r.timestamp DESC, r.id DESC LIMIT 1
            ) latest ON TRUE
            LEFT JOIN LATERAL (
                WITH samples AS (
                    (SELECT r.id, r.timestamp, r."energyKwh" FROM "GenerationReading" r
                     WHERE r."installationId" = i.id AND r.timestamp <= ${start}::timestamp
                     ORDER BY r.timestamp DESC, r.id DESC LIMIT 1)
                    UNION ALL
                    SELECT r.id, r.timestamp, r."energyKwh" FROM "GenerationReading" r
                    WHERE r."installationId" = i.id
                        AND r.timestamp > ${start}::timestamp AND r.timestamp <= ${asOf}::timestamp
                ), canonical AS (
                    SELECT DISTINCT ON (timestamp) timestamp, "energyKwh"
                    FROM samples ORDER BY timestamp, id DESC
                ), intervals AS (
                    SELECT timestamp, "energyKwh",
                        LAG(timestamp) OVER (ORDER BY timestamp) AS previous_time,
                        LAG("energyKwh") OVER (ORDER BY timestamp) AS previous_energy
                    FROM canonical
                )
                SELECT COALESCE(SUM(
                    CASE WHEN previous_time IS NOT NULL AND timestamp > previous_time
                        THEN GREATEST(0, "energyKwh" - previous_energy)
                            * EXTRACT(EPOCH FROM timestamp - GREATEST(previous_time, ${start}::timestamp))
                            / EXTRACT(EPOCH FROM timestamp - previous_time)
                        ELSE 0 END
                ), 0)::float8 AS total,
                    COUNT(*) FILTER (WHERE previous_time IS NOT NULL)::int AS intervals,
                    COALESCE(BOOL_OR(timestamp <= ${start}::timestamp), FALSE) AS baseline
                FROM intervals
            ) energy ON TRUE`;
        const round = value => Math.round(value * 1000000) / 1000000;
        res.json({
            district: { id: district.id, name: district.name, provinceId: district.provinceId },
            installationCount: summary.installationCount,
            currentTotalPowerKw: round(summary.currentTotalPowerKw),
            todayTotalEnergyKwh: round(summary.todayTotalEnergyKwh),
            coverage: {
                installationsWithReading: summary.installationsWithReading,
                installationsWithoutReading: summary.installationCount - summary.installationsWithReading,
                installationsWithTodayEnergyData: summary.installationsWithTodayEnergyData,
                installationsWithMidnightBaseline: summary.installationsWithMidnightBaseline,
            },
            context: {
                timezone: "Asia/Colombo", localDate, dayStart: start, dayEndExclusive: end,
                oldestLatestReadingAt: summary.oldestLatestReadingAt,
                latestReadingAt: summary.latestReadingAt,
                powerBasis: "Latest timestamp per installation at or before the request; no freshness assumption",
                energyBasis: "Non-negative cumulative counter increments; midnight-crossing intervals prorated by elapsed time; no extrapolation",
            },
        });
    };
}

module.exports = { districtGenerationSummary, sriLankanDay };
