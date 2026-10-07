const createApp = require("./app");
const prisma = require("./prisma/client");

const app = createApp(prisma);

const PORT = Number(process.env.PORT || 3000);

// Omitting host binds to the unspecified address, suitable for cloud ingress.
const server = app.listen(PORT, () => {
    console.log(`Server listening on port ${server.address().port}`);
});
