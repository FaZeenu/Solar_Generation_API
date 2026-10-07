require("./helpers/auth");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const createApp = require("../app");
const { version } = require("../package.json");

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
        assert.deepEqual(document.paths, {});
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
