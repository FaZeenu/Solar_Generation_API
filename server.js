const createApp = require("./app");
const prisma = require("./prisma/client");

const app = createApp(prisma);

const PORT = 3000;

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
