module.exports = function documentInstallationReadings({ schemas, parameters, responses, paths }) {
    const ref = name => ({ $ref: `#/components/schemas/${name}` });
    const id = schemas.SolarInstallation.properties.id;
    const timestamp = {
        type: "string", format: "date-time",
        pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?(?:Z|[+-]\\d{2}:\\d{2})$",
        description: "Valid ISO 8601 calendar datetime with seconds and explicit timezone; optional 1–3 fractional digits.",
    };
    const reading = { id: 100, installationId: 1, timestamp: "2026-01-02T06:30:00.000Z", powerKw: 4.5, energyKwh: 12.8, voltage: 230 };
    const fields = {
        timestamp,
        powerKw: { type: "number", format: "double", description: "Instantaneous power in kW." },
        energyKwh: { type: "number", format: "double", description: "Cumulative energy counter in kWh; not energy for just this reporting interval." },
        voltage: { type: "number", format: "double", description: "Voltage in volts." },
    };
    schemas.GenerationReading = {
        type: "object", additionalProperties: false,
        required: ["id", "installationId", ...Object.keys(fields)],
        properties: { id, installationId: id, ...fields }, example: reading,
    };
    schemas.GenerationReadingInput = {
        type: "object", additionalProperties: false, required: Object.keys(fields),
        properties: {
            ...fields,
            powerKw: { ...fields.powerKw, minimum: 0 },
            energyKwh: { ...fields.energyKwh, minimum: 0 },
            voltage: { ...fields.voltage, minimum: 0 },
            installationId: { ...id, description: "Optional. If supplied, must equal the installationId in the URL. The URL determines ownership." },
        },
        example: { timestamp: "2026-01-02T12:00:00+05:30", powerKw: 4.5, energyKwh: 12.8, voltage: 230 },
    };
    const nestedDistrict = {
        ...schemas.District, required: [...schemas.District.required, "province"],
        properties: { ...schemas.District.properties, province: ref("Province") },
        example: { ...schemas.District.example, province: schemas.Province.example },
    };
    const nestedSubstation = {
        ...schemas.GridSubstation, required: [...schemas.GridSubstation.required, "district"],
        properties: { ...schemas.GridSubstation.properties, district: nestedDistrict },
        example: { ...schemas.GridSubstation.example, district: nestedDistrict.example },
    };
    schemas.InstallationComposite = {
        ...schemas.SolarInstallation,
        required: [...schemas.SolarInstallation.required, "substation", "latestReading"],
        properties: {
            ...schemas.SolarInstallation.properties, substation: nestedSubstation,
            latestReading: { ...schemas.GenerationReading, nullable: true, description: "Single latest reading by timestamp descending, then ID descending; null when no readings exist." },
        },
        example: { ...schemas.SolarInstallation.example, substation: nestedSubstation.example, latestReading: reading },
    };
    schemas.PaginatedGenerationReadings = {
        ...schemas.PaginatedSolarInstallations,
        properties: {
            ...schemas.PaginatedSolarInstallations.properties,
            data: { type: "array", items: ref("GenerationReading") },
            count: { type: "integer", minimum: 0, description: "Total readings for this installation matching the time range, across all pages." },
        },
    };
    for (const [key, name, description] of [
        ["ReadingFrom", "from", "Inclusive lower timestamp bound. Encode + as %2B in query strings."],
        ["ReadingTo", "to", "Inclusive upper timestamp bound. Must not precede from. Encode + as %2B in query strings."],
    ]) parameters[key] = { name, in: "query", description, schema: timestamp, example: "2026-01-02T00:00:00+05:30" };
    parameters.ReadingSort = { name: "sort", in: "query", description: "Timestamp direction; ID is a deterministic tie-breaker in the same direction. Other values and repeated parameters return 400.", schema: { type: "string", enum: ["asc", "desc"], default: "asc" }, example: "desc" };
    const installationId = { name: "installationId", in: "path", required: true, schema: id, example: 1 };
    const readingId = { name: "readingId", in: "path", required: true, schema: id, example: 100 };
    function operation(summary, schema, example, description, extra = []) {
        return {
            summary, description, parameters: [installationId, ...extra],
            responses: {
                200: { description: "Successful JSON response.", content: { "application/json": { schema, example } } },
                400: { $ref: "#/components/responses/BadRequest" },
                404: { description: "Installation or requested reading does not exist; a reading under another installation is also not found.", content: { "application/json": { schema: ref("Error"), example: { code: "NOT_FOUND", message: "Resource not found", detail: "GenerationReading not found" } } } },
                406: { $ref: "#/components/responses/NotAcceptable" },
            },
        };
    }
    const base = "/installations/{installationId}";
    paths[`${base}/composite`] = { get: operation("Get an installation composite", ref("InstallationComposite"), schemas.InstallationComposite.example, "Installation with its substation, district, province and one latest reading. Historical readings are not embedded; latestReading is null when the installation has no readings.") };
    paths[`${base}/last-known-reading`] = { get: operation("Get the last-known generation reading", ref("GenerationReading"), reading, "Derived from timestamp descending, then ID descending; not a hard-coded reading ID. Returns 404 when the installation has no readings or does not exist.") };
    const history = operation("List an installation's historical readings", ref("PaginatedGenerationReadings"), {
        data: [reading], count: 1, page: 1, limit: 20, next: null, previous: null,
    }, "Readings belong only to the URL installation. Inclusive from/to bounds combine with pagination and timestamp sorting. Default page 1, limit 20 (maximum 100), sort asc. Missing installation returns 404; an empty history or range returns data [] and count 0. Malformed timestamps, from later than to, repeated query values, unsupported sort, or invalid pagination return 400.", ["Page", "Limit", "ReadingFrom", "ReadingTo", "ReadingSort"].map(name => ({ $ref: `#/components/parameters/${name}` })));
    const ingestion = {
        summary: "Append a generation reading",
        description: "Creates a separate time-series reading owned by the URL installation. Required numeric fields must be finite and non-negative. A supplied installationId must match the URL; unknown fields (including id) are rejected. This does not replace or edit historical readings.",
        parameters: [installationId],
        requestBody: { required: true, content: { "application/json": { schema: ref("GenerationReadingInput"), example: schemas.GenerationReadingInput.example } } },
        responses: {
            201: {
                description: "Reading created. Following Location retrieves this resource.",
                headers: { Location: { description: "Relative URI of the created reading scoped to its installation.", schema: { type: "string" }, example: "/installations/1/readings/100" } },
                content: { "application/json": { schema: ref("GenerationReading"), example: reading } },
            },
            400: { description: "Invalid path ID, malformed JSON, missing/invalid fields, unknown fields or conflicting installationId.", content: { "application/json": { schema: ref("Error"), example: { code: "BAD_REQUEST", message: "Bad request", detail: "installationId must match the installation in the URL" } } } },
            404: { description: "Installation not found.", content: { "application/json": { schema: ref("Error"), example: { code: "NOT_FOUND", message: "Resource not found", detail: "SolarInstallation not found" } } } },
            406: { $ref: "#/components/responses/NotAcceptable" },
        },
    };
    paths[`${base}/readings`] = { get: history, post: ingestion };
    paths[`${base}/readings/{readingId}`] = { get: operation("Get one reading belonging to this installation", ref("GenerationReading"), reading, "Both IDs must be valid. A reading can only be retrieved through its owning installation; another installation URL returns 404.", [readingId]) };
};
