require("./helpers/auth");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const createApp = require("../app");
const { version } = require("../package.json");
const document = require("../docs/openapi");
const { authenticatedFetch } = require("./helpers/auth");

const expectedPaths = [
    "/provinces", "/provinces/{provinceId}", "/provinces/{provinceId}/districts",
    "/districts", "/districts/{districtId}", "/districts/{districtId}/substations",
    "/substations", "/substations/{substationId}", "/substations/{substationId}/installations",
    "/installations", "/installations/{installationId}",
];
function resolve(value) {
    if (!value.$ref) return value;
    return value.$ref.slice(2).split("/").reduce((result, key) => result[key], document);
}
function validate(value, schema) {
    schema = resolve(schema);
    if (value === null && schema.nullable) return;
    if (schema.type === "object") {
        assert(value && typeof value === "object" && !Array.isArray(value));
        for (const key of schema.required || []) assert(Object.hasOwn(value, key), `Missing ${key}`);
        for (const [key, field] of Object.entries(value)) {
            if (schema.additionalProperties === false) assert(Object.hasOwn(schema.properties, key), `Unexpected ${key}`);
            if (schema.properties[key]) validate(field, schema.properties[key]);
        }
    } else if (schema.type === "array") {
        assert(Array.isArray(value)); for (const item of value) validate(item, schema.items);
    } else if (schema.type === "integer") {
        assert(Number.isInteger(value));
        if (schema.minimum !== undefined) assert(value >= schema.minimum);
        if (schema.maximum !== undefined) assert(value <= schema.maximum);
    } else if (schema.type === "string") assert.equal(typeof value, "string");
    else assert.fail(`Unsupported test schema type ${schema.type}`);
}

test("minimal OpenAPI/Swagger infrastructure", async t => {
    // Documentation requests must not query the database or require a bearer token.
    const server = createApp({}).listen(0, "127.0.0.1");
    t.after(() => new Promise(resolve => server.close(resolve)));
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;

    await t.test("/api-docs is accessible with a browser's HTML Accept header", async () => {
        const response = await fetch(`${base}/api-docs`, { headers: { Accept: "text/html" } });
        assert.equal(response.status, 200);
        assert.match(response.headers.get("content-type"), /text\/html/);
        assert.match(await response.text(), /swagger-ui/);
    });
    await t.test("/openapi.json returns a valid minimal OpenAPI 3 document", async () => {
        const response = await fetch(`${base}/openapi.json`, { headers: { Accept: "application/json" } });
        assert.equal(response.status, 200);
        assert.match(response.headers.get("content-type"), /application\/json/);
        const document = await response.json();
        assert.equal(document.openapi, "3.0.3");
        assert.equal(document.info.title, "Sri Lanka Solar Generation REST API");
        assert.equal(document.info.version, version);
        assert.equal(typeof document.info.description, "string");
        assert(document.info.description.length > 0);
        assert.equal(Object.keys(document.paths).length, 11);
    });
    await t.test("Swagger assets are served and the UI loads /openapi.json", async () => {
        const css = await fetch(`${base}/api-docs/swagger-ui.css`, { headers: { Accept: "text/css" } });
        assert.equal(css.status, 200);
        assert.match(css.headers.get("content-type"), /text\/css/);
        const script = await fetch(`${base}/api-docs/swagger-ui-init.js`);
        assert.equal(script.status, 200);
        assert.match(await script.text(), /\/openapi\.json/);
    });
});

test("OpenAPI hierarchy GET contract", async t => {
    await t.test("exactly the 11 requested GET paths; no writes, security or later resources", () => {
        assert.deepEqual(Object.keys(document.paths).sort(), [...expectedPaths].sort());
        for (const item of Object.values(document.paths)) assert.deepEqual(Object.keys(item), ["get"]);
        assert(!document.security); assert(!document.components.securitySchemes);
    });
    await t.test("path parameters are required, typed and complete", () => {
        for (const [path, item] of Object.entries(document.paths)) {
            const names = [...path.matchAll(/\{([^}]+)\}/g)].map(match => match[1]);
            const parameters = item.get.parameters.map(resolve).filter(parameter => parameter.in === "path");
            assert.deepEqual(parameters.map(parameter => parameter.name), names);
            for (const parameter of parameters) {
                assert.equal(parameter.required, true); assert.equal(parameter.schema.type, "integer");
                assert.equal(parameter.schema.minimum, 1); assert.equal(parameter.schema.maximum, 2147483647);
            }
        }
    });
    await t.test("pagination/filter parameters appear only on paginated installation collections", () => {
        for (const [path, item] of Object.entries(document.paths)) {
            const query = item.get.parameters.map(resolve).filter(parameter => parameter.in === "query");
            const paginated = ["/installations", "/substations/{substationId}/installations"].includes(path);
            assert.deepEqual(query.map(parameter => parameter.name), paginated ? ["page", "limit", "provinceId", "districtId", "substationId"] : []);
            if (paginated) {
                assert.equal(query[0].schema.default, 1); assert.equal(query[1].schema.default, 20); assert.equal(query[1].schema.maximum, 100);
            }
        }
    });
    await t.test("responses and examples resolve to the shared schemas", () => {
        for (const [path, item] of Object.entries(document.paths)) {
            assert(item.get.responses[200]); assert(item.get.responses[406]);
            if (path.includes("{")) { assert(item.get.responses[400]); assert(item.get.responses[404]); }
            for (const response of Object.values(item.get.responses)) {
                const media = resolve(response).content["application/json"];
                validate(media.example, media.schema);
            }
        }
    });
});

test("documented schemas match actual seeded hierarchy responses", async t => {
    const prisma = require("../prisma/client");
    const server = createApp(prisma).listen(0, "127.0.0.1");
    t.after(async () => { await new Promise(resolve => server.close(resolve)); await prisma.$disconnect(); });
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    const ids = {
        provinceId: (await prisma.province.findFirst()).id,
        districtId: (await prisma.district.findFirst()).id,
        substationId: (await prisma.gridSubstation.findFirst()).id,
        installationId: (await prisma.solarInstallation.findFirst()).id,
    };
    for (const path of expectedPaths) {
        const url = path.replace(/\{([^}]+)\}/g, (_, name) => ids[name]);
        const response = await authenticatedFetch(base + url);
        assert.equal(response.status, 200);
        validate(await response.json(), document.paths[path].get.responses[200].content["application/json"].schema);
    }
    for (const [url, status, headers] of [
        ["/provinces/0", 400], ["/installations?limit=0", 400],
        ["/districts/2147483647/substations", 404], ["/provinces", 406, { Accept: "text/html" }],
    ]) {
        const response = await authenticatedFetch(base + url, { headers });
        assert.equal(response.status, status);
        validate(await response.json(), document.components.schemas.Error);
    }
});
