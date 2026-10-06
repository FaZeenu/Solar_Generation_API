const express = require("express");
const createResourceRouter = require("./routes/resources");

function createApp(prisma) {
    const app = express();
    app.locals.prisma = prisma;

    app.get("/", (req, res) => {
        res.send("Solar Generation API is running");
    });
    app.use(createResourceRouter(prisma));
    app.use((req, res) => {
        res.status(404).json({ error: "Route not found" });
    });
    // Express 5 forwards rejected async handlers here, keeping errors JSON.
    app.use((error, req, res, next) => {
        console.error("API request failed:", error.message);
        res.status(500).json({ error: "Internal server error" });
    });
    return app;
}

module.exports = createApp;
