module.exports = function documentJwtSecurity({ paths, responses }) {
    const securitySchemes = {
        BearerAuth: {
            type: "http", scheme: "bearer", bearerFormat: "JWT",
            description: "Send Authorization: Bearer <JWT>. The API verifies HS256 signatures, expiry, issuer and audience. Claims sub (non-empty identity) and exp (expiry) are required; nbf is enforced when present. The issuer/audience are configured with JWT_ISSUER/JWT_AUDIENCE, defaulting to solar-generation/solar-generation-api. scope is a space-separated string. installation-write requires a numeric positive installationId and can POST readings only for that installation. analyst-read-by-district requires a numeric positive districtId and permits installation/readings and generation-summary access only within that district; collections and counts are automatically constrained, and explicit requests for another jurisdiction return 403. hierarchy-admin permits hierarchy administration, installation reads and district summaries across districts; it does not by itself permit reading ingestion. Tokens are provisioned by a trusted signing authority; this API has no public token-issuing endpoint. No tokens or signing secrets are included in this specification.",
        },
    };
    responses.Unauthorized = {
        description: "Missing, malformed, invalid-signature, expired, not-yet-valid or otherwise invalid bearer token (including missing required identity/expiry or incorrect issuer/audience).",
        headers: { "WWW-Authenticate": { schema: { type: "string" }, example: 'Bearer realm="solar-generation"' } },
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" }, example: { code: "UNAUTHORIZED", message: "Authentication required", detail: "A valid, unexpired bearer token is required." } } },
    };
    responses.Forbidden = {
        description: "Authenticated token lacks the required scope or a valid jurisdiction claim, targets another installation, or requests installation/readings data outside its authorized district.",
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" }, example: { code: "FORBIDDEN", message: "Access forbidden", detail: "The token does not permit access to this scope or jurisdiction." } } },
    };
    for (const [path, item] of Object.entries(paths)) {
        for (const [method, operation] of Object.entries(item)) {
            const ingestion = method === "post" && path === "/installations/{installationId}/readings";
            const write = ["post", "patch", "delete"].includes(method);
            const summary = path === "/districts/{districtId}/generation-summary";
            const protectedRead = method === "get" && (path.startsWith("/installations") || path === "/substations/{substationId}/installations" || summary);
            if (!write && !protectedRead) {
                operation.security = [];
                continue;
            }
            // HTTP bearer requirements use an empty array, not OAuth scope arrays.
            // Scope checks are described separately to match this JWT implementation.
            operation.security = [{ BearerAuth: [] }];
            operation.responses[401] = { $ref: "#/components/responses/Unauthorized" };
            operation.responses[403] = { $ref: "#/components/responses/Forbidden" };
            operation["x-required-scopes"] = ingestion ? ["installation-write"] : write ? ["hierarchy-admin"] : ["analyst-read-by-district", "hierarchy-admin"];
            operation["x-scope-match"] = "any";
            const description = ingestion
                ? "Requires installation-write and a numeric installationId claim matching the URL installationId. A token for another installation returns 403, even if it also has hierarchy-admin."
                : write
                    ? "Requires hierarchy-admin for this hierarchy write operation. Analyst/device scopes alone do not grant hierarchy administration."
                    : summary
                        ? "Requires analyst-read-by-district with districtId matching the URL district, or hierarchy-admin for cross-district access. An analyst requesting another district receives 403. Missing/invalid/expired authentication returns 401. Authorization runs before conditional GET."
                        : "Requires analyst-read-by-district with a numeric districtId matching the resource's district, or hierarchy-admin for cross-district access. Analysts receive only their district's collection data/counts; another district or explicit conflicting jurisdiction filter returns 403. Authorization runs before conditional GET, so an ETag cannot bypass access checks.";
            operation.description += ` ${description}`;
        }
    }
    return securitySchemes;
};
