require("./helpers/auth");
require("dotenv/config");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const path = require("node:path");

test("production entry point listens on the environment port and serves the existing app", async t => {
    const child = spawn(process.execPath, ["server.js"], {
        cwd: path.resolve(__dirname, ".."),
        // Port zero asks the OS for a free port, avoiding collisions in tests.
        env: { ...process.env, PORT: "0", NODE_ENV: "production" },
        stdio: ["ignore", "pipe", "pipe"],
    });
    t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) {
            const exited = once(child, "exit");
            child.kill();
            await exited;
        }
    });
    const port = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Production server startup timed out")), 10000);
        let output = "";
        child.once("error", error => { clearTimeout(timer); reject(error); });
        child.once("exit", code => { clearTimeout(timer); reject(new Error(`Production server exited before readiness (${code})`)); });
        child.stdout.on("data", data => {
            output += data.toString();
            const match = /Server listening on port (\d+)/.exec(output);
            if (match) { clearTimeout(timer); resolve(Number(match[1])); }
        });
        // Drain stderr without exposing any environment or configuration details.
        child.stderr.resume();
    });
    assert(port > 0);
    const base = `http://127.0.0.1:${port}`;
    const response = await fetch(base);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "Solar Generation API is running");
    const specification = await fetch(`${base}/openapi.json`);
    assert.equal(specification.status, 200);
    assert.equal((await specification.json()).openapi, "3.0.3");
});
