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
        if (schema.minProperties !== undefined) assert(Object.keys(value).length >= schema.minProperties);
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
    } else if (schema.type === "number") {
        assert.equal(typeof value, "number"); assert(Number.isFinite(value));
        if (schema.minimum !== undefined) assert(value >= schema.minimum);
    } else if (schema.type === "string") {
        assert.equal(typeof value, "string");
        if (schema.pattern) assert(new RegExp(schema.pattern).test(value));
        if (schema.format === "date-time") assert(Number.isFinite(Date.parse(value)));
        if (schema.enum) assert(schema.enum.includes(value));
    }
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
        assert.equal(Object.keys(document.paths).length, 16);
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

test("final OpenAPI coursework route and HTTP consistency audit", async t => {
    await t.test("exactly 29 implemented operations on 16 resource paths; no duplicate or nonexistent operations", () => {
        const matrix = {};
        for (const [path, id] of [["provinces", "provinceId"], ["districts", "districtId"], ["substations", "substationId"], ["installations", "installationId"]]) {
            matrix[`/${path}`] = ["get", "post"];
            matrix[`/${path}/{${id}}`] = ["get", "patch", "delete"];
        }
        for (const path of ["/provinces/{provinceId}/districts", "/districts/{districtId}/substations", "/substations/{substationId}/installations", "/installations/{installationId}/composite", "/installations/{installationId}/last-known-reading", "/installations/{installationId}/readings/{readingId}", "/districts/{districtId}/generation-summary"]) matrix[path] = ["get"];
        matrix["/installations/{installationId}/readings"] = ["get", "post"];
        assert.deepEqual(Object.keys(document.paths).sort(), Object.keys(matrix).sort());
        const signatures = [];
        for (const [path, methods] of Object.entries(matrix)) {
            assert.deepEqual(Object.keys(document.paths[path]).sort(), [...methods].sort());
            signatures.push(...methods.map(method => `${method} ${path}`));
        }
        assert.equal(signatures.length, 29); assert.equal(new Set(signatures).size, 29);
    });
    await t.test("all references resolve, all path parameters match templates, and examples match schemas", () => {
        function walk(value) {
            if (!value || typeof value !== "object") return;
            if (value.$ref) assert(resolve(value), value.$ref);
            for (const nested of Object.values(value)) walk(nested);
        }
        walk(document);
        for (const [path, item] of Object.entries(document.paths)) {
            for (const operation of Object.values(item)) {
                const parameters = operation.parameters.map(resolve);
                assert.equal(new Set(parameters.map(p => `${p.in}:${p.name}`)).size, parameters.length);
                assert.deepEqual(parameters.filter(p => p.in === "path").map(p => p.name), [...path.matchAll(/\{([^}]+)\}/g)].map(match => match[1]));
                for (const raw of Object.values(operation.responses)) {
                    const response = resolve(raw);
                    if (response.content) {
                        const media = response.content["application/json"];
                        validate(media.example, media.schema);
                    }
                }
            }
        }
    });
    await t.test("GET validators/304/412 and write Location/ETag/cache headers are documented", () => {
        for (const item of Object.values(document.paths)) {
            for (const [method, operation] of Object.entries(item)) {
                assert(operation.responses[500]);
                if (method === "get") {
                    assert(operation.responses[200].headers.ETag); assert(operation.responses[200].headers.Vary);
                    assert(operation.responses[200].headers["Cache-Control"]);
                    assert(operation.parameters.map(resolve).some(p => p.name === "If-None-Match"));
                    assert(operation.responses[304]); assert(!operation.responses[304].content);
                    assert(operation.responses[412]); assert(!operation.responses[200].headers["Last-Modified"]);
                } else {
                    if (method === "post") assert(operation.responses[201].headers.Location);
                    if (method === "patch") assert(operation.responses[200].headers.ETag);
                    if (method === "delete") { assert(operation.responses[204]); assert(!operation.responses[204].content); }
                    if (["post", "patch"].includes(method)) assert(operation.responses[413]);
                }
            }
        }
    });
    await t.test("summary has the actual fields, nullable source times and JWT requirements", () => {
        const schema = document.components.schemas.DistrictGenerationSummary;
        validate(schema.example, schema);
        validate({ ...schema.example, context: { ...schema.example.context, oldestLatestReadingAt: null, latestReadingAt: null } }, schema);
        assert.deepEqual(Object.keys(schema.properties), ["district", "installationCount", "currentTotalPowerKw", "todayTotalEnergyKwh", "coverage", "context"]);
        const operation = document.paths["/districts/{districtId}/generation-summary"].get;
        assert.deepEqual(operation.security, [{ BearerAuth: [] }]);
        assert.deepEqual(operation["x-required-scopes"], ["analyst-read-by-district", "hierarchy-admin"]);
        for (const status of [200, 304, 400, 401, 403, 404, 406, 412, 500]) assert(operation.responses[status]);
    });
});

test("summary schema, authorization and validators match actual seeded responses", async t => {
    const { token } = require("./helpers/auth");
    const prisma = require("../prisma/client");
    const district = await prisma.district.findFirst();
    const other = await prisma.district.findFirst({ where: { id: { not: district.id } } });
    const server = createApp(prisma).listen(0, "127.0.0.1");
    t.after(async () => { await new Promise(resolve => server.close(resolve)); await prisma.$disconnect(); });
    await once(server, "listening");
    const origin = `http://127.0.0.1:${server.address().port}`;
    const path = `/districts/${district.id}/generation-summary`;
    const operation = document.paths["/districts/{districtId}/generation-summary"].get;
    const authorization = { Authorization: `Bearer ${token({ scope: "analyst-read-by-district", districtId: district.id })}` };
    const response = await fetch(origin + path, { headers: authorization });
    assert.equal(response.status, 200);
    validate(await response.json(), operation.responses[200].content["application/json"].schema);
    assert.equal(response.headers.get("cache-control"), operation.responses[200].headers["Cache-Control"].example);
    const cached = await fetch(origin + path, { headers: { ...authorization, "If-None-Match": response.headers.get("etag") } });
    assert.equal(cached.status, 304); assert.equal(await cached.text(), "");
    for (const [url, status, headers] of [[path, 401, {}], [`/districts/${other.id}/generation-summary`, 403, authorization], ["/districts/abc/generation-summary", 400, { Authorization: `Bearer ${token({ scope: "hierarchy-admin" })}` }]]) {
        const result = await fetch(origin + url, { headers });
        assert.equal(result.status, status);
        validate(await result.json(), resolve(operation.responses[status]).content["application/json"].schema);
    }
    const missing = await authenticatedFetch(origin + "/districts/2147483647/generation-summary");
    assert.equal(missing.status, 404);
    validate(await missing.json(), operation.responses[404].content["application/json"].schema);
});

test("OpenAPI JWT security contract", async t => {
    await t.test("HTTP Bearer JWT scheme describes scopes and identity/jurisdiction claims", () => {
        const scheme = document.components.securitySchemes.BearerAuth;
        assert.equal(scheme.type, "http"); assert.equal(scheme.scheme, "bearer"); assert.equal(scheme.bearerFormat, "JWT");
        for (const value of ["installation-write", "analyst-read-by-district", "hierarchy-admin", "installationId", "districtId", "sub", "exp"]) assert(scheme.description.includes(value));
        assert(!scheme.flows); assert(!scheme.example);
    });
    await t.test("all 21 protected operations have Bearer requirements and shared 401/403 responses", () => {
        let protectedCount = 0;
        for (const [path, item] of Object.entries(document.paths)) {
            for (const [method, operation] of Object.entries(item)) {
                const ingestion = path === "/installations/{installationId}/readings" && method === "post";
                const write = ["post", "patch", "delete"].includes(method);
                const read = method === "get" && (path.startsWith("/installations") || path === "/substations/{substationId}/installations" || path === "/districts/{districtId}/generation-summary");
                if (!write && !read) continue;
                protectedCount++;
                assert.deepEqual(operation.security, [{ BearerAuth: [] }]);
                assert.equal(operation.responses[401].$ref, "#/components/responses/Unauthorized");
                assert.equal(operation.responses[403].$ref, "#/components/responses/Forbidden");
                assert.deepEqual(operation["x-required-scopes"], ingestion ? ["installation-write"] : write ? ["hierarchy-admin"] : ["analyst-read-by-district", "hierarchy-admin"]);
                assert.equal(operation["x-scope-match"], "any");
            }
        }
        assert.equal(protectedCount, 21);
    });
    await t.test("all eight public geographic GET operations remain public; summary included", () => {
        assert(!document.security);
        let publicCount = 0;
        for (const [path, item] of Object.entries(document.paths)) {
            if (!item.get || path.startsWith("/installations") || path === "/substations/{substationId}/installations" || path === "/districts/{districtId}/generation-summary") continue;
            publicCount++;
            assert.deepEqual(item.get.security, []);
            assert(!item.get.responses[401]); assert(!item.get.responses[403]);
        }
        assert.equal(publicCount, 8);
        assert(document.paths["/districts/{districtId}/generation-summary"].get);
    });
    await t.test("401/403 examples reuse Error and include the real bearer challenge", () => {
        for (const name of ["Unauthorized", "Forbidden"]) {
            const media = document.components.responses[name].content["application/json"];
            assert.equal(media.schema.$ref, "#/components/schemas/Error"); validate(media.example, media.schema);
        }
        assert.equal(document.components.responses.Unauthorized.headers["WWW-Authenticate"].example, 'Bearer realm="solar-generation"');
    });
});

test("documented 401/403 responses and public access match the actual API", async t => {
    const { token } = require("./helpers/auth");
    const prisma = require("../prisma/client");
    const installation = await prisma.solarInstallation.findFirst();
    const server = createApp(prisma).listen(0, "127.0.0.1");
    t.after(async () => { await new Promise(resolve => server.close(resolve)); await prisma.$disconnect(); });
    await once(server, "listening");
    const origin = `http://127.0.0.1:${server.address().port}`;
    const path = `/installations/${installation.id}`;
    for (const headers of [{}, { Authorization: "Bearer invalid" }, { Authorization: `Bearer ${token({ scope: "hierarchy-admin" }, { expiresIn: -1 })}` }]) {
        const response = await fetch(origin + path, { headers });
        assert.equal(response.status, 401);
        assert.equal(response.headers.get("www-authenticate"), document.components.responses.Unauthorized.headers["WWW-Authenticate"].example);
        assert.deepEqual(await response.json(), document.components.responses.Unauthorized.content["application/json"].example);
    }
    const denied = await fetch(origin + path, { headers: { Authorization: `Bearer ${token({ scope: "installation-write", installationId: installation.id })}` } });
    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), document.components.responses.Forbidden.content["application/json"].example);
    for (const publicPath of ["/provinces", "/districts", "/substations"]) assert.equal((await fetch(origin + publicPath)).status, 200);
});

test("OpenAPI hierarchy write contracts", async t => {
    for (const [path, name, pathId] of [
        ["provinces", "Province", "provinceId"], ["districts", "District", "districtId"],
        ["substations", "GridSubstation", "substationId"], ["installations", "SolarInstallation", "installationId"],
    ]) {
        await t.test(`${name} create/update schemas, headers and response codes match the implementation`, () => {
            const post = document.paths[`/${path}`].post;
            const patch = document.paths[`/${path}/{${pathId}}`].patch;
            const remove = document.paths[`/${path}/{${pathId}}`].delete;
            assert(post && patch && remove);
            const create = document.components.schemas[`${name}Create`];
            const update = document.components.schemas[`${name}Update`];
            assert.deepEqual(create.required.sort(), Object.keys(create.properties).sort());
            assert.equal(create.additionalProperties, false); assert.equal(update.additionalProperties, false);
            assert.equal(update.minProperties, 1); assert(!update.required);
            assert(!create.properties.id); assert(!update.properties.id);
            for (const [operation, statuses] of [[post, [201, 400, 409, 406]], [patch, [200, 400, 404, 409, 412, 406]], [remove, [204, 400, 404, 409, 412, 406]]]) {
                for (const status of statuses) assert(operation.responses[status]);
                for (const response of Object.values(operation.responses)) {
                    const resolved = resolve(response);
                    if (resolved.content) {
                        const media = resolved.content["application/json"];
                        validate(media.example, media.schema);
                    }
                }
            }
            assert(post.requestBody.required); assert(patch.requestBody.required);
            validate(create.example, create); validate(update.example, update);
            assert(post.responses[201].headers.Location); assert(post.responses[201].headers.ETag);
            assert(patch.responses[200].headers.ETag);
            assert(!remove.responses[204].content); assert(!remove.requestBody);
            for (const operation of [patch, remove]) {
                const parameters = operation.parameters.map(resolve);
                assert.equal(parameters[0].name, pathId); assert.equal(parameters[0].required, true);
                assert.equal(parameters[1].name, "If-Match"); assert.equal(parameters[1].required, false);
            }
        });
    }
    await t.test("security documented, summary included; readings remain append-only", () => {
        assert(!document.security); assert(document.components.securitySchemes.BearerAuth);
        assert(document.paths["/districts/{districtId}/generation-summary"].get);
        for (const [path, item] of Object.entries(document.paths)) {
            if (path.includes("readings")) { assert(!item.patch); assert(!item.delete); }
        }
        assert.match(document.components.schemas.GenerationReading.description, /Append-only/);
    });
});

test("documented hierarchy writes match real responses with rollback-only resources", async t => {
    const prisma = require("../prisma/client");
    const rollback = new Error("Intentional write documentation rollback");
    const models = ["province", "district", "gridSubstation", "solarInstallation", "generationReading", "user"];
    const counts = () => Promise.all(models.map(model => prisma[model].count()));
    const before = await counts();
    try {
        await prisma.$transaction(async tx => {
            const server = createApp(tx).listen(0, "127.0.0.1");
            try {
                await once(server, "listening");
                const origin = `http://127.0.0.1:${server.address().port}`;
                const created = [];
                for (const [path, name, pathId, parent] of [
                    ["provinces", "Province", "provinceId"], ["districts", "District", "districtId", "provinceId"],
                    ["substations", "GridSubstation", "substationId", "districtId"], ["installations", "SolarInstallation", "installationId", "substationId"],
                ]) {
                    const input = { ...document.components.schemas[`${name}Create`].example };
                    if (parent) input[parent] = created.at(-1).body.id;
                    const post = document.paths[`/${path}`].post;
                    const response = await authenticatedFetch(`${origin}/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
                    assert.equal(response.status, 201);
                    const body = await response.json(); validate(body, post.responses[201].content["application/json"].schema);
                    const location = response.headers.get("location"); assert.equal(location, `/${path}/${body.id}`);
                    const get = await authenticatedFetch(origin + location);
                    assert.deepEqual(await get.json(), body); assert.equal(get.headers.get("etag"), response.headers.get("etag"));
                    const patch = document.paths[`/${path}/{${pathId}}`].patch;
                    const update = await authenticatedFetch(origin + location, { method: "PATCH", headers: { "Content-Type": "application/json", "If-Match": response.headers.get("etag") }, body: JSON.stringify(document.components.schemas[`${name}Update`].example) });
                    assert.equal(update.status, 200);
                    const updated = await update.json(); validate(updated, patch.responses[200].content["application/json"].schema);
                    const stale = await authenticatedFetch(origin + location, { method: "DELETE", headers: { "If-Match": response.headers.get("etag") } });
                    assert.equal(stale.status, 412); validate(await stale.json(), document.components.schemas.Error);
                    created.push({ path, pathId, location, body: updated, etag: update.headers.get("etag") });
                }
                for (const resource of created.slice(0, 3)) {
                    const denied = await authenticatedFetch(origin + resource.location, { method: "DELETE", headers: { "If-Match": resource.etag } });
                    assert.equal(denied.status, 409); validate(await denied.json(), document.components.schemas.Error);
                }
                for (const resource of created.reverse()) {
                    const response = await authenticatedFetch(origin + resource.location, { method: "DELETE", headers: { "If-Match": resource.etag } });
                    assert.equal(response.status, 204); assert.equal(await response.text(), "");
                }
            } finally { await new Promise(resolve => server.close(resolve)); }
            throw rollback;
        }, { timeout: 60000 });
    } catch (error) { if (error !== rollback) throw error; }
    finally {
        try { assert.deepEqual(await counts(), before); }
        finally { await prisma.$disconnect(); }
    }
});

test("OpenAPI hierarchy GET contract", async t => {
    await t.test("the 11 hierarchy GET operations remain; summary included", () => {
        for (const path of expectedPaths) assert(document.paths[path].get);
        assert(document.paths["/districts/{districtId}/generation-summary"].get);
        assert(!document.security); assert(document.components.securitySchemes.BearerAuth);
    });
    await t.test("path parameters are required, typed and complete", () => {
        for (const path of expectedPaths) {
            const item = document.paths[path];
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
        for (const path of expectedPaths) {
            const item = document.paths[path];
            const query = item.get.parameters.map(resolve).filter(parameter => parameter.in === "query");
            const paginated = ["/installations", "/substations/{substationId}/installations"].includes(path);
            assert.deepEqual(query.map(parameter => parameter.name), paginated ? ["page", "limit", "provinceId", "districtId", "substationId"] : []);
            if (paginated) {
                assert.equal(query[0].schema.default, 1); assert.equal(query[1].schema.default, 20); assert.equal(query[1].schema.maximum, 100);
            }
        }
    });
    await t.test("responses and examples resolve to the shared schemas", () => {
        for (const path of expectedPaths) {
            const item = document.paths[path];
            assert(item.get.responses[200]); assert(item.get.responses[406]);
            if (path.includes("{")) { assert(item.get.responses[400]); assert(item.get.responses[404]); }
            for (const response of Object.values(item.get.responses)) {
                if (!resolve(response).content) continue;
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

test("OpenAPI installation readings contract", async t => {
    const base = "/installations/{installationId}";
    const operations = [
        [`${base}/composite`, "get"], [`${base}/last-known-reading`, "get"],
        [`${base}/readings`, "get"], [`${base}/readings/{readingId}`, "get"], [`${base}/readings`, "post"],
    ];
    await t.test("only the five new operations are documented with matching parameters and responses", () => {
        assert.equal(Object.keys(document.paths).length, 16);
        for (const [path, method] of operations) {
            const operation = document.paths[path][method];
            assert(operation);
            const expected = [...path.matchAll(/\{([^}]+)\}/g)].map(match => match[1]);
            const actual = operation.parameters.map(resolve).filter(parameter => parameter.in === "path");
            assert.deepEqual(actual.map(parameter => parameter.name), expected);
            assert(actual.every(parameter => parameter.required && parameter.schema.minimum === 1));
            for (const status of [method === "post" ? 201 : 200, 400, 404, 406]) assert(operation.responses[status]);
            for (const response of Object.values(operation.responses)) {
                if (!resolve(response).content) continue;
                const media = resolve(response).content["application/json"];
                validate(media.example, media.schema);
            }
        }
        assert.deepEqual(Object.keys(document.paths[`${base}/readings`]), ["get", "post"]);
        assert(!document.security); assert(document.components.securitySchemes.BearerAuth);
    });
    await t.test("history documents page/limit, inclusive from/to and timestamp sort", () => {
        const query = document.paths[`${base}/readings`].get.parameters.map(resolve).filter(parameter => parameter.in === "query");
        assert.deepEqual(query.map(parameter => parameter.name), ["page", "limit", "from", "to", "sort"]);
        assert.equal(query[0].schema.default, 1); assert.equal(query[1].schema.maximum, 100);
        assert.equal(query[2].schema.format, "date-time"); assert.equal(query[3].schema.format, "date-time");
        assert.deepEqual(query[4].schema.enum, ["asc", "desc"]); assert.equal(query[4].schema.default, "asc");
    });
    await t.test("POST body has exactly the writable fields and documents Location", () => {
        const operation = document.paths[`${base}/readings`].post;
        assert.equal(operation.requestBody.required, true);
        const media = operation.requestBody.content["application/json"];
        const schema = resolve(media.schema);
        assert.deepEqual(schema.required, ["timestamp", "powerKw", "energyKwh", "voltage"]);
        assert.deepEqual(Object.keys(schema.properties).sort(), ["energyKwh", "installationId", "powerKw", "timestamp", "voltage"]);
        assert.equal(schema.additionalProperties, false);
        validate(schema.example, schema);
        assert.equal(schema.example.voltage, 230);
        assert.equal(media.example.voltage, 230);
        validate(media.example, schema);
        assert.equal(operation.responses[201].headers.Location.example, "/installations/1/readings/100");
    });
    await t.test("composite contains nested hierarchy and nullable single latest reading", () => {
        const schema = document.components.schemas.InstallationComposite;
        validate(schema.example, schema);
        validate({ ...schema.example, latestReading: null }, schema);
        assert(!schema.properties.readings);
        assert(schema.properties.substation.properties.district.properties.province);
    });
});

test("documented reading responses and POST Location match the real API without polluting seed", async t => {
    const prisma = require("../prisma/client");
    const rollback = new Error("Intentional documentation test rollback");
    const before = await prisma.generationReading.count();
    try {
        await prisma.$transaction(async tx => {
            const installation = await tx.solarInstallation.findFirst();
            const reading = await tx.generationReading.findFirst({ where: { installationId: installation.id } });
            const server = createApp(tx).listen(0, "127.0.0.1");
            try {
                await once(server, "listening");
                const origin = `http://127.0.0.1:${server.address().port}`;
                const template = "/installations/{installationId}";
                const base = `/installations/${installation.id}`;
                for (const suffix of ["/composite", "/last-known-reading", "/readings", "/readings/{readingId}"]) {
                    const path = base + suffix.replace("{readingId}", reading.id);
                    const response = await authenticatedFetch(origin + path);
                    assert.equal(response.status, 200);
                    validate(await response.json(), document.paths[template + suffix].get.responses[200].content["application/json"].schema);
                }
                const operation = document.paths[template + "/readings"].post;
                const response = await authenticatedFetch(origin + base + "/readings", {
                    method: "POST", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(operation.requestBody.content["application/json"].example),
                });
                assert.equal(response.status, 201);
                const created = await response.json();
                validate(created, operation.responses[201].content["application/json"].schema);
                const location = response.headers.get("location");
                assert.equal(location, `${base}/readings/${created.id}`);
                assert.deepEqual(await (await authenticatedFetch(origin + location)).json(), created);
            } finally {
                await new Promise(resolve => server.close(resolve));
            }
            throw rollback;
        }, { timeout: 60000 });
    } catch (error) {
        if (error !== rollback) throw error;
    } finally {
        try { assert.equal(await prisma.generationReading.count(), before); }
        finally { await prisma.$disconnect(); }
    }
});
