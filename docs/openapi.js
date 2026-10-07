const { version } = require("../package.json");

const ref = name => ({ $ref: `#/components/schemas/${name}` });
const id = { type: "integer", format: "int32", minimum: 1, maximum: 2147483647 };
const examples = {
    Province: { id: 1, name: "Western" },
    District: { id: 1, name: "Colombo", provinceId: 1 },
    GridSubstation: { id: 1, name: "Demo Colombo Grid Substation", districtId: 1 },
    SolarInstallation: { id: 1, name: "Demo Colombo Solar 1", meterId: "SEED-LK-01-001", substationId: 1 },
};
function model(name, fields) {
    return {
        type: "object", required: ["id", "name", ...Object.keys(fields)], additionalProperties: false,
        properties: { id, name: { type: "string" }, ...fields }, example: examples[name],
    };
}
const schemas = {
    Province: model("Province", {}),
    District: model("District", { provinceId: id }),
    GridSubstation: model("GridSubstation", { districtId: id }),
    SolarInstallation: model("SolarInstallation", { meterId: { type: "string", description: "Unique meter/inverter identifier belonging to this installation." }, substationId: id }),
    Error: {
        type: "object", required: ["code", "message", "detail"], additionalProperties: false,
        properties: { code: { type: "string" }, message: { type: "string" }, detail: { type: "string" } },
        example: { code: "NOT_FOUND", message: "Resource not found", detail: "Province not found" },
    },
    PaginatedSolarInstallations: {
        type: "object", required: ["data", "count", "page", "limit", "next", "previous"], additionalProperties: false,
        properties: {
            data: { type: "array", items: ref("SolarInstallation") },
            count: { type: "integer", minimum: 0, description: "Total installations matching all filters and the collection's scope, across every page." },
            page: { ...id, description: "Requested page number." },
            limit: { type: "integer", minimum: 1, maximum: 100 },
            next: { type: "string", nullable: true, description: "Relative next-page URL preserving filters, or null when no next page exists." },
            previous: { type: "string", nullable: true, description: "Relative previous-page URL preserving filters, or null on the first page." },
        },
    },
};
const parameters = {
    Page: { name: "page", in: "query", description: "Positive page number. (page - 1) × limit must not exceed 2147483647. Repeated values are rejected.", schema: { ...id, default: 1 }, example: 1 },
    Limit: { name: "limit", in: "query", description: "Records per page; maximum 100. Repeated values are rejected.", schema: { type: "integer", minimum: 1, maximum: 100, default: 20 }, example: 10 },
};
for (const name of ["provinceId", "districtId", "substationId"]) {
    parameters[name] = { name, in: "query", description: `Filter installations by ${name}. Filters combine using AND.`, schema: id, example: 1 };
}
const paginationParameters = ["Page", "Limit", "provinceId", "districtId", "substationId"].map(name => ({ $ref: `#/components/parameters/${name}` }));
const responses = {};
for (const [name, description, code, message, detail] of [
    ["BadRequest", "Invalid path ID or pagination/filter value.", "BAD_REQUEST", "Bad request", "limit must be a positive integer no greater than 100"],
    ["NotFound", "The individual resource or parent resource does not exist.", "NOT_FOUND", "Resource not found", "District not found"],
    ["NotAcceptable", "The requested representation is unsupported; application/json and */* are accepted.", "NOT_ACCEPTABLE", "Not acceptable", "This API supports application/json only."],
]) {
    responses[name] = { description, content: { "application/json": { schema: ref("Error"), example: { code, message, detail } } } };
}
function operation(summary, schema, example, { pathId, paginated = false } = {}) {
    const documentedResponses = {
        200: { description: "Successful JSON response.", content: { "application/json": { schema, example } } },
        406: { $ref: "#/components/responses/NotAcceptable" },
    };
    if (pathId || paginated) documentedResponses[400] = { $ref: "#/components/responses/BadRequest" };
    if (pathId) documentedResponses[404] = { $ref: "#/components/responses/NotFound" };
    return {
        summary,
        description: paginated
            ? "Ordered by ID ascending. Filters combine with pagination. An existing parent with no matching installations returns an empty data array and count 0. Pages beyond the last page return empty data with the matching total unchanged. Scoped collections cannot include installations outside their parent."
            : "Returns scalar resource fields and foreign-key IDs. Collections are ordered by ID ascending; an existing parent with no children returns an empty array.",
        parameters: [
            ...(pathId ? [{ name: pathId, in: "path", required: true, description: "Positive 32-bit resource ID; malformed IDs return 400.", schema: id, example: 1 }] : []),
            ...(paginated ? paginationParameters : []),
        ],
        responses: documentedResponses,
    };
}
const paths = {};
for (const [path, name, pathId, childPath, childName] of [
    ["provinces", "Province", "provinceId", "districts", "District"],
    ["districts", "District", "districtId", "substations", "GridSubstation"],
    ["substations", "GridSubstation", "substationId", "installations", "SolarInstallation"],
    ["installations", "SolarInstallation", "installationId"],
]) {
    const paginated = path === "installations";
    const pageExample = {
        data: Array.from({ length: 20 }, (_, index) => {
            const districtIndex = Math.floor(index / 8);
            const ordinal = index % 8 + 1;
            return { id: index + 1, name: `Demo ${["Colombo", "Gampaha", "Kalutara"][districtIndex]} Solar ${ordinal}`, meterId: `SEED-LK-${String(districtIndex + 1).padStart(2, "0")}-${String(ordinal).padStart(3, "0")}`, substationId: districtIndex + 1 };
        }),
        count: 200, page: 1, limit: 20, next: "/installations?page=2&limit=20", previous: null,
    };
    paths[`/${path}`] = { get: operation(`List ${path}`, paginated ? ref("PaginatedSolarInstallations") : { type: "array", items: ref(name) }, paginated ? pageExample : [examples[name]], { paginated }) };
    paths[`/${path}/{${pathId}}`] = { get: operation(`Get one ${name}`, ref(name), examples[name], { pathId }) };
    if (childPath) {
        const childPaginated = childPath === "installations";
        paths[`/${path}/{${pathId}}/${childPath}`] = { get: operation(`List ${childPath} belonging to this ${name}`, childPaginated ? ref("PaginatedSolarInstallations") : { type: "array", items: ref(childName) }, childPaginated ? { data: pageExample.data.slice(0, 8), count: 8, page: 1, limit: 20, next: null, previous: null } : [examples[childName]], { pathId, paginated: childPaginated }) };
    }
}

require("./installation-readings")({ schemas, parameters, responses, paths });
require("./hierarchy-writes")({ schemas, parameters, responses, paths });

module.exports = {
    openapi: "3.0.3",
    info: {
        title: "Sri Lanka Solar Generation REST API",
        version,
        description: "A REST API for Sri Lankan solar installations, generation readings and geographic hierarchy.",
    },
    paths,
    components: { schemas, parameters, responses },
};
