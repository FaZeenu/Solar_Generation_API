const express = require("express");
const createResourceRouter = require("./routes/resources");

function createApp(prisma) {
    const app = express();
    app.locals.prisma = prisma;
    app.use(express.json());

    app.get("/", (req, res) => {
        res.send("Solar Generation API is running");
    });
    app.use(createResourceRouter(prisma));
    app.use((req, res) => {
        res.status(404).json({ error: "Route not found" });
    });
    // Express 5 forwards rejected async handlers here, keeping errors JSON.
    app.use((error, req, res, next) => {
        if (error.status === 400) return res.status(400).json({ error: error.message });
        if (error.type === "entity.parse.failed") {
            return res.status(400).json({ error: "Malformed JSON body" });
        }
        console.error("API request failed:", error.message);
        res.status(500).json({ error: "Internal server error" });
    });
    return app;
}

module.exports = createApp;
