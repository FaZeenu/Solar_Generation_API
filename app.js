const express = require("express");
const createResourceRouter = require("./routes/resources");
const { httpSemantics } = require("./middleware/http-semantics");
const { createSecurityMiddleware } = require("./middleware/authentication");
const swaggerUi = require("swagger-ui-express");
const openapi = require("./docs/openapi");

function createApp(prisma) {
    const app = express();
    app.disable("etag");
    app.locals.prisma = prisma;
    // Swagger serves HTML/CSS/JS, so mount it before JSON-only API negotiation.
    app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(null, {
        swaggerOptions: { url: "/openapi.json", validatorUrl: null },
    }));
    app.use(httpSemantics);
    app.use(createSecurityMiddleware(prisma));
    app.use(express.json());
    app.get("/openapi.json", (req, res) => res.json(openapi));

    app.get("/", (req, res) => {
        res.send("Solar Generation API is running");
    });
    app.use(createResourceRouter(prisma));
    app.use((req, res) => {
        res.apiError(404, "Route not found");
    });
    // Express 5 forwards rejected async handlers here, keeping errors JSON.
    app.use((error, req, res, next) => {
        if (error.type === "entity.parse.failed") {
            return res.apiError(400, "Malformed JSON body");
        }
        if (error.type === "entity.too.large") return res.apiError(413, "JSON body exceeds the permitted size");
        if (error.status === 400) return res.apiError(400, error.message);
        res.apiError(500, "The request could not be completed.");
    });
    return app;
}

module.exports = createApp;
