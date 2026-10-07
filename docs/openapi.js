const { version } = require("../package.json");

module.exports = {
    openapi: "3.0.3",
    info: {
        title: "Sri Lanka Solar Generation REST API",
        version,
        description: "A REST API for Sri Lankan solar installations, generation readings and geographic hierarchy.",
    },
    // Endpoint documentation will be added in a separate stage.
    paths: {},
};
