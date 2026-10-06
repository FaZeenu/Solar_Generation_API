const express = require("express");

function validateReading(body, installationId) {
    if (!body || typeof body !== "object" || Array.isArray(body)) return "A JSON object is required";
    const allowed = ["timestamp", "powerKw", "energyKwh", "voltage", "installationId"];
    if (Object.keys(body).some(key => !allowed.includes(key))) return "Unexpected reading field";
    if (Object.hasOwn(body, "installationId") && body.installationId !== installationId) {
        return "installationId must match the installation in the URL";
    }
    for (const key of ["powerKw", "energyKwh", "voltage"]) {
        if (typeof body[key] !== "number" || !Number.isFinite(body[key]) || body[key] < 0) {
            return `${key} must be a finite non-negative number`;
        }
    }
    // Require an explicit timezone; reject impossible dates instead of JS date rollover.
    const match = typeof body.timestamp === "string" && body.timestamp.match(
        /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/
    );
    if (!match || !Number.isFinite(Date.parse(body.timestamp))) return "timestamp must be a valid ISO 8601 datetime with a timezone";
    const [, year, month, day] = match.map(Number);
    const calendar = new Date(0);
    calendar.setUTCFullYear(year, month - 1, day);
    if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day || /T24:/.test(body.timestamp)) {
        return "timestamp contains an invalid calendar date or time";
    }
    return null;
}

function createInstallationReadingRouter(prisma) {
    const router = express.Router({ mergeParams: true });
    const latestOrder = [{ timestamp: "desc" }, { id: "desc" }];

    router.get("/composite", async (req, res) => {
        const installation = await prisma.solarInstallation.findUnique({
            where: { id: res.locals.resource.id },
            include: {
                substation: { include: { district: { include: { province: true } } } },
                readings: { orderBy: latestOrder, take: 1 },
            },
        });
        if (!installation) return res.status(404).json({ error: "SolarInstallation not found" });
        const { readings, ...resource } = installation;
        res.json({ ...resource, latestReading: readings[0] || null });
    });

    router.get("/last-known-reading", async (req, res) => {
        const reading = await prisma.generationReading.findFirst({
            where: { installationId: res.locals.resource.id }, orderBy: latestOrder,
        });
        if (!reading) return res.status(404).json({ error: "GenerationReading not found" });
        res.json(reading);
    });

    router.get("/readings", async (req, res) => {
        const readings = await prisma.generationReading.findMany({
            where: { installationId: res.locals.resource.id },
            orderBy: [{ timestamp: "asc" }, { id: "asc" }],
        });
        res.json(readings);
    });

    router.post("/readings", async (req, res) => {
        const installationId = res.locals.resource.id;
        const error = validateReading(req.body, installationId);
        if (error) return res.status(400).json({ error });
        const { timestamp, powerKw, energyKwh, voltage } = req.body;
        const reading = await prisma.generationReading.create({
            data: { installationId, timestamp: new Date(timestamp), powerKw, energyKwh, voltage },
        });
        res.location(`/installations/${installationId}/readings/${reading.id}`).status(201).json(reading);
    });

    router.get("/readings/:readingId", async (req, res) => {
        const rawId = req.params.readingId;
        const id = Number(rawId);
        if (!/^[1-9]\d*$/.test(rawId) || !Number.isInteger(id) || id > 2147483647) {
            return res.status(400).json({ error: "readingId must be a positive 32-bit integer" });
        }
        const reading = await prisma.generationReading.findFirst({
            where: { id, installationId: res.locals.resource.id },
        });
        if (!reading) return res.status(404).json({ error: "GenerationReading not found" });
        res.json(reading);
    });
    return router;
}

module.exports = createInstallationReadingRouter;
