module.exports = function documentHierarchyWrites({ schemas, parameters, responses, paths }) {
    const ref = name => ({ $ref: `#/components/schemas/${name}` });
    const etag = { description: "Strong ETag computed from the returned scalar JSON representation; matches the atomic GET representation for the same state.", schema: { type: "string" }, example: `"${"a".repeat(64)}"` };
    parameters.IfMatch = {
        name: "If-Match", in: "header", required: false,
        description: "Optional conditional write. Use the current atomic GET ETag, including its quotes. A matching strong tag or * permits the operation; a stale, incorrect or weak tag returns 412. A list is accepted if any strong tag matches. When omitted the operation is unconditional. The check and mutation run in the same locked transaction.",
        schema: { type: "string" }, example: etag.example,
    };
    function failure(description, code, message, detail) {
        return { description, content: { "application/json": { schema: ref("Error"), example: { code, message, detail } } } };
    }
    responses.WriteBadRequest = failure("Malformed JSON, invalid fields/ID, empty PATCH, read-only/unknown fields, or nonexistent referenced parent. Parent failures return 400, not 404.", "BAD_REQUEST", "Bad request", "Unknown or read-only fields are not permitted.");
    responses.WriteConflict = failure("Unique-field collision or relationship conflict. No dependent resources are silently cascade-deleted.", "CONFLICT", "Resource conflict", "A resource with the same unique fields already exists.");
    responses.DependencyConflict = failure("Deletion blocked because dependent resources exist. Remove or reassign dependents first; historical readings have no normal deletion endpoint.", "CONFLICT", "Resource conflict", "Dependent resources exist; remove or reassign them before deleting this resource.");
    responses.PreconditionFailed = failure("Supplied If-Match does not match the current scalar resource representation. No mutation takes place.", "PRECONDITION_FAILED", "Precondition failed", "The supplied If-Match does not match the current representation.");
    for (const [path, name, pathId, parent, dependents] of [
        ["provinces", "Province", "provinceId", null, "districts"],
        ["districts", "District", "districtId", "provinceId", "substations"],
        ["substations", "GridSubstation", "substationId", "districtId", "installations"],
        ["installations", "SolarInstallation", "installationId", "substationId", "generation readings"],
    ]) {
        const text = { type: "string", minLength: 1, pattern: "\\S", description: "Non-empty string; whitespace-only values are rejected. Values are preserved as supplied." };
        const properties = { name: text };
        const example = { name: `New ${name}` };
        if (name === "SolarInstallation") {
            properties.meterId = { ...text, description: "Unique meter/inverter identifier; remains an installation attribute." };
            example.meterId = "COURSEWORK-METER-NEW-001";
        }
        if (parent) { properties[parent] = schemas[name].properties[parent]; example[parent] = 1; }
        schemas[`${name}Create`] = { type: "object", additionalProperties: false, required: Object.keys(properties), properties, example };
        schemas[`${name}Update`] = { type: "object", additionalProperties: false, minProperties: 1, properties, example: { name: `Updated ${name}` }, description: "Supply at least one writable field. Omitted fields are preserved. id and embedded relations are not writable." };
        const body = suffix => ({ required: true, content: { "application/json": { schema: ref(`${name}${suffix}`), example: schemas[`${name}${suffix}`].example } } });
        const atomic = `/${path}/{${pathId}}`;
        paths[atomic].get.responses[200].headers = { ETag: etag };
        paths[`/${path}`].post = {
            summary: `Create a ${name}`, description: `Creates one resource.${parent ? ` ${parent} must reference an existing parent.` : ""} The server generates id; unknown fields are rejected.`,
            parameters: [], requestBody: body("Create"),
            responses: {
                201: {
                    description: "Resource created; following Location retrieves the created JSON resource.",
                    headers: { Location: { description: "Relative atomic resource URI.", schema: { type: "string" }, example: `/${path}/501` }, ETag: etag },
                    content: { "application/json": { schema: ref(name), example: { id: 501, ...example } } },
                },
                400: { $ref: "#/components/responses/WriteBadRequest" },
                409: { $ref: "#/components/responses/WriteConflict" },
                406: { $ref: "#/components/responses/NotAcceptable" },
            },
        };
        const pathParameter = paths[atomic].get.parameters.find(parameter => parameter.in === "path");
        const writeParameters = [pathParameter, { $ref: "#/components/parameters/IfMatch" }];
        paths[atomic].patch = {
            summary: `Partially update a ${name}`, description: "Updates only supplied writable fields, preserving all other fields. Invalid/missing referenced parents return 400. The response is the updated scalar resource and its new ETag.",
            parameters: writeParameters, requestBody: body("Update"),
            responses: {
                200: { description: "Updated JSON representation.", headers: { ETag: etag }, content: { "application/json": { schema: ref(name), example: { ...schemas[name].example, name: `Updated ${name}` } } } },
                400: { $ref: "#/components/responses/WriteBadRequest" },
                404: { $ref: "#/components/responses/NotFound" },
                409: { $ref: "#/components/responses/WriteConflict" },
                412: { $ref: "#/components/responses/PreconditionFailed" },
                406: { $ref: "#/components/responses/NotAcceptable" },
            },
        };
        paths[atomic].delete = {
            summary: `Delete a ${name}`, description: `Deletes only when no dependent ${dependents} exist. No cascade deletion. GenerationReading is append-only: normal API CRUD never updates or deletes historical readings, and installations with readings cannot be deleted.`,
            parameters: writeParameters,
            responses: {
                204: { description: "Deleted successfully. Response body is empty; no JSON representation is returned." },
                400: { $ref: "#/components/responses/WriteBadRequest" },
                404: { $ref: "#/components/responses/NotFound" },
                409: { $ref: "#/components/responses/DependencyConflict" },
                412: { $ref: "#/components/responses/PreconditionFailed" },
                406: { $ref: "#/components/responses/NotAcceptable" },
            },
        };
    }
    schemas.GenerationReading.description = "Append-only time-series data. POST appends a reading; normal API CRUD does not update or delete historical readings. Last-known-reading is derived from this history.";
};
