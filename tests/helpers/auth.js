const { randomBytes } = require("node:crypto");
const jwt = require("jsonwebtoken");

// Ephemeral process-local key; never a production secret or authentication bypass.
process.env.JWT_SECRET = randomBytes(48).toString("hex");
process.env.JWT_ISSUER = "solar-generation";
process.env.JWT_AUDIENCE = "solar-generation-api";

function token(claims = {}, options = {}) {
    return jwt.sign({ sub: "test-identity", ...claims }, process.env.JWT_SECRET, {
        algorithm: "HS256", issuer: process.env.JWT_ISSUER, audience: process.env.JWT_AUDIENCE,
        expiresIn: "15m", ...options,
    });
}

function authenticatedFetch(input, options = {}) {
    const url = new URL(input);
    const headers = new Headers(options.headers);
    const id = /^\/installations\/([1-9]\d*)/.exec(url.pathname);
    if (!headers.has("Authorization")) {
        headers.set("Authorization", `Bearer ${token({ scope: "hierarchy-admin installation-write", installationId: id ? Number(id[1]) : 1 })}`);
    }
    return fetch(input, { ...options, headers });
}

module.exports = { token, authenticatedFetch };
