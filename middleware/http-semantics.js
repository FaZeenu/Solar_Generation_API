const { createHash } = require("node:crypto");

const errors = {
    400: ["BAD_REQUEST", "Bad request"],
    404: ["NOT_FOUND", "Resource not found"],
    406: ["NOT_ACCEPTABLE", "Not acceptable"],
    409: ["CONFLICT", "Resource conflict"],
    412: ["PRECONDITION_FAILED", "Precondition failed"],
    413: ["PAYLOAD_TOO_LARGE", "Payload too large"],
    500: ["INTERNAL_SERVER_ERROR", "Internal server error"],
};

function errorBody(status, detail) {
    const [code, message] = errors[status] || errors[500];
    return { code, message, detail };
}

function tags(header) {
    return header.match(/(?:W\/)?"[^"\r\n]*"/g) || [];
}

// Strong comparison is required for If-Match. Call this with current state in
// the same transaction as any future update/delete to avoid a check/write race.
function ifMatchSatisfied(header, etag, exists = true) {
    if (header === undefined) return true;
    if (header.trim() === "*") return exists;
    return exists && tags(header).some(tag => !tag.startsWith("W/") && tag === etag);
}

function requireIfMatch(req, res, etag, exists = true) {
    if (ifMatchSatisfied(req.get("If-Match"), etag, exists)) return true;
    res.status(412).json(errorBody(412, "The supplied If-Match does not match the current representation."));
    return false;
}

function representationEtag(body) {
    return `"${createHash("sha256").update(JSON.stringify(body)).digest("hex")}"`;
}

function sendRepresentation(req, res, body, lastModified) {
    const serialized = JSON.stringify(body);
    const etag = representationEtag(body);
    res.set("ETag", etag);
    res.set("Cache-Control", "no-cache");
    // Only callers with a real modification timestamp may supply this value.
    const modified = lastModified instanceof Date ? lastModified.getTime() : NaN;
    const hasModified = Number.isFinite(modified) && modified <= Date.now();
    if (hasModified) res.set("Last-Modified", lastModified.toUTCString());
    if (!requireIfMatch(req, res, etag)) return res;
    const noneMatch = req.get("If-None-Match");
    let unchanged = false;
    if (noneMatch !== undefined) {
        unchanged = noneMatch.trim() === "*" || tags(noneMatch).some(tag => tag.replace(/^W\//, "") === etag);
    } else if (hasModified) {
        const since = req.get("If-Modified-Since");
        // Reject arbitrary Date.parse strings; HTTP dates include GMT and a weekday.
        const httpDate = since && /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(since);
        const parsed = httpDate ? Date.parse(since) : NaN;
        unchanged = Number.isFinite(parsed) && Math.floor(modified / 1000) <= Math.floor(parsed / 1000);
    }
    if (unchanged) return res.status(304).end();
    res.type("json");
    res.set("Content-Length", String(Buffer.byteLength(serialized)));
    return res.end(serialized);
}

function httpSemantics(req, res, next) {
    res.apiError = (status, detail) => res.status(status).json(errorBody(status, detail));
    // Preserve the pre-existing human-readable root status page.
    if (req.path === "/") return next();
    res.vary("Accept");
    res.set("Cache-Control", "no-store");
    if (!req.accepts("application/json")) {
        return res.apiError(406, "This API supports application/json only.");
    }
    const originalJson = res.json.bind(res);
    res.json = body => {
        if ((req.method === "GET" || req.method === "HEAD") && res.statusCode === 200) {
            return sendRepresentation(req, res, body);
        }
        return originalJson(body);
    };
    next();
}

module.exports = { httpSemantics, sendRepresentation, errorBody, ifMatchSatisfied, requireIfMatch, representationEtag };
