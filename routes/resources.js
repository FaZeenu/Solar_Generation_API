const express = require("express");

// Scalar model fields are returned directly; foreign-key IDs link related resources.
const resources = [
    { path: "provinces", model: "province", parameter: "provinceId", label: "Province", child: { path: "districts", model: "district", foreignKey: "provinceId" } },
    { path: "districts", model: "district", parameter: "districtId", label: "District", child: { path: "substations", model: "gridSubstation", foreignKey: "districtId" } },
    { path: "substations", model: "gridSubstation", parameter: "substationId", label: "GridSubstation", child: { path: "installations", model: "solarInstallation", foreignKey: "substationId" } },
    { path: "installations", model: "solarInstallation", parameter: "installationId", label: "SolarInstallation" },
];

function createResourceRouter(prisma) {
    const router = express.Router();
    for (const resource of resources) {
        router.get(`/${resource.path}`, async (req, res) => {
            const rows = await prisma[resource.model].findMany({ orderBy: { id: "asc" } });
            res.json(rows);
        });

        // Resolve the parent once for both the individual and its scoped collection.
        router.param(resource.parameter, async (req, res, next, rawId) => {
            const id = Number(rawId);
            if (!/^[1-9]\d*$/.test(rawId) || !Number.isInteger(id) || id > 2147483647) {
                return res.status(400).json({ error: `${resource.parameter} must be a positive 32-bit integer` });
            }
            const row = await prisma[resource.model].findUnique({ where: { id } });
            if (!row) return res.status(404).json({ error: `${resource.label} not found` });
            res.locals.resource = row;
            next();
        });

        router.get(`/${resource.path}/:${resource.parameter}`, (req, res) => {
            res.json(res.locals.resource);
        });

        if (resource.child) {
            const child = resource.child;
            router.get(`/${resource.path}/:${resource.parameter}/${child.path}`, async (req, res) => {
                const rows = await prisma[child.model].findMany({
                    where: { [child.foreignKey]: res.locals.resource.id },
                    orderBy: { id: "asc" },
                });
                res.json(rows);
            });
        }
    }
    return router;
}

module.exports = createResourceRouter;
