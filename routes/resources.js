const express = require("express");
const createInstallationReadingRouter = require("./installation-readings");
const { installationFilters, paginatedCollection } = require("./collection-query");
const registerHierarchyWrites = require("./hierarchy-writes");

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
            if (resource.model === "solarInstallation") {
                const filters = installationFilters(req.query);
                const where = res.locals.authorizedDistrictId
                    ? { AND: [filters, { substation: { districtId: res.locals.authorizedDistrictId } }] } : filters;
                return res.json(await paginatedCollection(req, prisma.solarInstallation, where, { id: "asc" }));
            }
            const rows = await prisma[resource.model].findMany({ orderBy: { id: "asc" } });
            res.json(rows);
        });

        // Resolve the parent once for both the individual and its scoped collection.
        router.param(resource.parameter, async (req, res, next, rawId) => {
            const id = Number(rawId);
            if (!/^[1-9]\d*$/.test(rawId) || !Number.isInteger(id) || id > 2147483647) {
                return res.apiError(400, `${resource.parameter} must be a positive 32-bit integer`);
            }
            const row = await prisma[resource.model].findUnique({ where: { id } });
            if (!row) return res.apiError(404, `${resource.label} not found`);
            res.locals.resource = row;
            next();
        });

        router.get(`/${resource.path}/:${resource.parameter}`, (req, res) => {
            res.json(res.locals.resource);
        });
        registerHierarchyWrites(router, prisma, resource);

        if (resource.child) {
            const child = resource.child;
            router.get(`/${resource.path}/:${resource.parameter}/${child.path}`, async (req, res) => {
                if (child.model === "solarInstallation") {
                    const where = { AND: [installationFilters(req.query), { substationId: res.locals.resource.id }] };
                    if (res.locals.authorizedDistrictId) where.AND.push({ substation: { districtId: res.locals.authorizedDistrictId } });
                    return res.json(await paginatedCollection(req, prisma.solarInstallation, where, { id: "asc" }));
                }
                const rows = await prisma[child.model].findMany({
                    where: { [child.foreignKey]: res.locals.resource.id },
                    orderBy: { id: "asc" },
                });
                res.json(rows);
            });
        }
    }
    router.use("/installations/:installationId", createInstallationReadingRouter(prisma));
    return router;
}

module.exports = createResourceRouter;
