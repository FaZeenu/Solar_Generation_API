module.exports = function documentHttpSemantics({ paths, parameters, responses }) {
    const header = description => ({ schema: { type: "string" }, description });
    parameters.IfNoneMatch = {
        name: "If-None-Match", in: "header", required: false, schema: { type: "string" },
        description: "Current ETag, a comma-separated tag list, or *. Weak comparison is accepted. A match produces 304 with an empty body. Checked after authentication and authorization.",
    };
    parameters.IfMatchRead = {
        name: "If-Match", in: "header", required: false, schema: { type: "string" },
        description: "Optional GET precondition. Matching strong ETag, a list containing one, or * allows retrieval; a mismatch or weak-only match produces 412.",
    };
    const etag = header("Stable strong ETag calculated from the actual JSON representation.");
    responses.GetPreconditionFailed = {
        description: "If-Match does not strongly match the selected representation.",
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" }, example: { code: "PRECONDITION_FAILED", message: "Precondition failed", detail: "The supplied If-Match does not match the current representation." } } },
    };
    responses.PayloadTooLarge = {
        description: "JSON body exceeds the Express parser's permitted size (default 100kb, or 102,400 bytes).",
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" }, example: { code: "PAYLOAD_TOO_LARGE", message: "Payload too large", detail: "JSON body exceeds the permitted size" } } },
    };
    responses.InternalServerError = {
        description: "Unexpected server failure; no database internals or sensitive details are exposed.",
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" }, example: { code: "INTERNAL_SERVER_ERROR", message: "Internal server error", detail: "The request could not be completed." } } },
    };
    for (const item of Object.values(paths)) {
        for (const [method, operation] of Object.entries(item)) {
            operation.responses[500] = { $ref: "#/components/responses/InternalServerError" };
            if (["post", "patch"].includes(method)) operation.responses[413] = { $ref: "#/components/responses/PayloadTooLarge" };
            if (method !== "get") {
                for (const status of [200, 201, 204]) {
                    if (operation.responses[status]) operation.responses[status].headers = {
                        ...operation.responses[status].headers,
                        "Cache-Control": { ...header("Successful writes are not cached."), example: "no-store" },
                        Vary: { ...header("Write response varies by media negotiation and credentials."), example: "Accept, Authorization" },
                    };
                }
                continue;
            }
            const protectedRead = operation.security?.some(requirement => requirement.BearerAuth);
            const headers = {
                ETag: etag,
                "Cache-Control": { ...header("Revalidate cached representations; authenticated representations are private."), example: protectedRead ? "private, no-cache" : "no-cache" },
                Vary: { ...header("Representation varies by Accept and, for protected resources, Authorization."), example: protectedRead ? "Accept, Authorization" : "Accept" },
            };
            operation.responses[200].headers = { ...operation.responses[200].headers, ...headers };
            operation.responses[304] = { description: "Not modified. The response body is empty; validator/cache headers are retained.", headers };
            operation.responses[412] = { $ref: "#/components/responses/GetPreconditionFailed" };
            operation.parameters.push({ $ref: "#/components/parameters/IfNoneMatch" }, { $ref: "#/components/parameters/IfMatchRead" });
            operation.description += " GET responses include ETag and support If-None-Match/304. No Last-Modified is emitted because the models have no reliable modification timestamp; If-Modified-Since is therefore ignored.";
        }
    }
};
