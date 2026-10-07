const jwt = require("jsonwebtoken");

function jwtConfiguration() {
    const secret = process.env.JWT_SECRET;
    if (!secret || Buffer.byteLength(secret) < 32 || secret.startsWith("replace-")) {
        throw new Error("JWT_SECRET must be configured with at least 32 bytes of randomly generated secret material.");
    }
    return {
        secret,
        issuer: process.env.JWT_ISSUER || "solar-generation",
        audience: process.env.JWT_AUDIENCE || "solar-generation-api",
    };
}

function createSecurityMiddleware(prisma) {
    const config = jwtConfiguration();
    return async (req, res, next) => {
        // Express routes are case-insensitive and decode parameter values.
        // Classify the same effective path so encoding/case cannot bypass checks.
        let path;
        try { path = decodeURIComponent(req.path).toLowerCase(); }
        catch { return res.apiError(400, "Malformed request path."); }
        const hierarchy = /^\/(provinces|districts|substations|installations)(?:\/|$)/.test(path);
        const readingPost = req.method === "POST" && /^\/installations\/[^/]+\/readings\/?$/.test(path);
        const installationRead = ["GET", "HEAD"].includes(req.method) && (
            /^\/installations(?:\/|$)/.test(path) || /^\/substations\/[^/]+\/installations\/?$/.test(path)
        );
        const write = hierarchy && ["POST", "PATCH", "DELETE", "PUT"].includes(req.method);
        if (!write && !installationRead) return next();
        const header = req.get("Authorization");
        const match = header && /^Bearer ([^\s]+)$/i.exec(header);
        let claims;
        try {
            if (!match) throw new Error("Missing bearer token");
            claims = jwt.verify(match[1], config.secret, {
                algorithms: ["HS256"], issuer: config.issuer, audience: config.audience,
            });
            if (!claims || typeof claims !== "object" || typeof claims.sub !== "string" || !claims.sub.trim() || !Number.isFinite(claims.exp)) {
                throw new Error("Required identity or expiry missing");
            }
        } catch {
            res.set("WWW-Authenticate", 'Bearer realm="solar-generation"');
            return res.apiError(401, "A valid, unexpired bearer token is required.");
        }
        req.auth = claims;
        res.vary("Authorization");
        const scopes = new Set(typeof claims.scope === "string" ? claims.scope.split(/\s+/) : []);
        const forbidden = () => res.apiError(403, "The token does not permit access to this scope or jurisdiction.");
        const validId = id => Number.isInteger(id) && id > 0 && id <= 2147483647;
        if (readingPost) {
            if (!scopes.has("installation-write") || !validId(claims.installationId)) return forbidden();
            const rawId = path.split("/")[2];
            if (/^[1-9]\d*$/.test(rawId) && Number(rawId) !== claims.installationId) return forbidden();
            return next();
        }
        if (write) return scopes.has("hierarchy-admin") ? next() : forbidden();
        if (scopes.has("hierarchy-admin")) return next();
        if (!scopes.has("analyst-read-by-district") || !validId(claims.districtId)) return forbidden();
        const districtId = claims.districtId;
        const district = await prisma.district.findUnique({ where: { id: districtId }, select: { id: true, provinceId: true } });
        if (!district) return forbidden();
        res.locals.authorizedDistrictId = districtId;
        const scoped = /^\/substations\/([1-9]\d*)\/installations\/?$/.exec(path);
        if (scoped) {
            const id = Number(scoped[1]);
            if (validId(id)) {
                const substation = await prisma.gridSubstation.findUnique({ where: { id }, select: { districtId: true } });
                if (substation && substation.districtId !== districtId) return forbidden();
            }
        }
        const atomic = /^\/installations\/([1-9]\d*)(?:\/|$)/.exec(path);
        if (atomic) {
            const id = Number(atomic[1]);
            if (validId(id)) {
                const installation = await prisma.solarInstallation.findUnique({ where: { id }, select: { substation: { select: { districtId: true } } } });
                if (installation && installation.substation.districtId !== districtId) return forbidden();
            }
        }
        // Explicit requests for another jurisdiction are rejected, never silently
        // widened. Malformed query values are left to the existing 400 validator.
        const numericQuery = value => typeof value === "string" && /^[1-9]\d*$/.test(value) && validId(Number(value)) ? Number(value) : null;
        const requestedDistrict = numericQuery(req.query.districtId);
        const requestedProvince = numericQuery(req.query.provinceId);
        if (requestedDistrict && requestedDistrict !== districtId) return forbidden();
        if (requestedProvince && requestedProvince !== district.provinceId) return forbidden();
        const requestedSubstation = numericQuery(req.query.substationId);
        if (requestedSubstation) {
            const substation = await prisma.gridSubstation.findUnique({ where: { id: requestedSubstation }, select: { districtId: true } });
            if (substation && substation.districtId !== districtId) return forbidden();
        }
        next();
    };
}

module.exports = { createSecurityMiddleware, jwtConfiguration };
