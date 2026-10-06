const express = require("express");
const prisma = require("./prisma/client");

const app = express();
app.locals.prisma = prisma;

const PORT = 3000;

app.get("/", (req, res) => {
    res.send("Solar Generation API is running");
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
