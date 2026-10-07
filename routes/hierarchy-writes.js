const { representationEtag, ifMatchSatisfied } = require("../middleware/http-semantics");

// Fixed server-owned table names are used for PostgreSQL row locking.
const definitions = {
    province: { table: "Province", fields: ["name"], dependent: { model: "district", key: "provinceId" } },
    district: { table: "District", fields: ["name", "provinceId"], parent: { model: "province", key: "provinceId" }, dependent: { model: "gridSubstation", key: "districtId" } },
    gridSubstation: { table: "GridSubstation", fields: ["name", "districtId"], parent: { model: "district", key: "districtId" }, dependent: { model: "solarInstallation", key: "substationId" } },
    solarInstallation: { table: "SolarInstallation", fields: ["name", "meterId", "substationId"], parent: { model: "gridSubstation", key: "substationId" }, dependent: { model: "generationReading", key: "installationId" } },
};

function validate(body, definition, partial) {
    if (!body || typeof body !== "object" || Array.isArray(body)) return "A JSON object is required.";
    const keys = Object.keys(body);
    if (keys.length === 0) return "At least one resource field is required.";
    if (keys.some(key => !definition.fields.includes(key))) return "Unknown or read-only fields are not permitted.";
    if (!partial && definition.fields.some(key => !Object.hasOwn(body, key))) return "All required resource fields must be supplied.";
    for (const key of keys) {
        if (key.endsWith("Id") && key !== "meterId") {
            if (!Number.isInteger(body[key]) || body[key] <= 0 || body[key] > 2147483647) return `${key} must be a positive 32-bit integer.`;
        } else if (typeof body[key] !== "string" || !body[key].trim()) {
            return `${key} must be a non-empty string.`;
        }
    }
    return null;
}

async function transaction(prisma, callback) {
    // Integration tests pass an already-open transaction client, without $transaction.
    return typeof prisma.$transaction === "function"
        ? prisma.$transaction(callback, { timeout: 10000 }) : callback(prisma);
}

function registerHierarchyWrites(router, prisma, resource) {
    const definition = definitions[resource.model];
    const reply = (res, result) => {
        if (result.status >= 400) return res.apiError(result.status, result.detail);
        if (result.status === 204) return res.status(204).end();
        res.set("ETag", representationEtag(result.data));
        if (result.status === 201) res.location(`/${resource.path}/${result.data.id}`);
        return res.status(result.status).json(result.data);
    };
    async function parentError(tx, body) {
        if (definition.parent && Object.hasOwn(body, definition.parent.key)) {
            const found = await tx[definition.parent.model].findUnique({ where: { id: body[definition.parent.key] }, select: { id: true } });
            if (!found) return { status: 400, detail: "The referenced parent resource does not exist." };
        }
        return null;
    }
    const handle = operation => async (req, res, next) => {
        try { reply(res, await operation(req, res)); }
        catch (error) {
            if (error.code === "P2002") return res.apiError(409, "A resource with the same unique fields already exists.");
            if (error.code === "P2003") return res.apiError(409, "The operation conflicts with related resources.");
            if (error.code === "P2025") return res.apiError(404, `${resource.label} not found`);
            next(error);
        }
    };
    router.post(`/${resource.path}`, handle(async req => {
        const detail = validate(req.body, definition, false);
        if (detail) return { status: 400, detail };
        return transaction(prisma, async tx => {
            const invalidParent = await parentError(tx, req.body);
            if (invalidParent) return invalidParent;
            return { status: 201, data: await tx[resource.model].create({ data: req.body }) };
        });
    }));
    async function mutate(req, remove) {
        return transaction(prisma, async tx => {
            const id = Number(req.params[resource.parameter]);
            // Lock and read inside the write transaction: If-Match cannot race
            // another PATCH/DELETE between comparison and mutation.
            await tx.$queryRawUnsafe(`SELECT id FROM "${definition.table}" WHERE id = $1 FOR UPDATE`, id);
            const current = await tx[resource.model].findUnique({ where: { id } });
            if (!current) return { status: 404, detail: `${resource.label} not found` };
            if (!ifMatchSatisfied(req.get("If-Match"), representationEtag(current))) {
                return { status: 412, detail: "The supplied If-Match does not match the current representation." };
            }
            if (remove) {
                const dependent = definition.dependent;
                if (await tx[dependent.model].count({ where: { [dependent.key]: id } })) {
                    return { status: 409, detail: "Dependent resources exist; remove or reassign them before deleting this resource." };
                }
                await tx[resource.model].delete({ where: { id } });
                return { status: 204 };
            }
            const detail = validate(req.body, definition, true);
            if (detail) return { status: 400, detail };
            const invalidParent = await parentError(tx, req.body);
            if (invalidParent) return invalidParent;
            return { status: 200, data: await tx[resource.model].update({ where: { id }, data: req.body }) };
        });
    }
    router.patch(`/${resource.path}/:${resource.parameter}`, handle(req => mutate(req, false)));
    router.delete(`/${resource.path}/:${resource.parameter}`, handle(req => mutate(req, true)));
}

module.exports = registerHierarchyWrites;
