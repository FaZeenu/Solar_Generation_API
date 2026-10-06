function badQuery(message) {
    const error = new Error(message);
    error.status = 400;
    throw error;
}

function positiveInteger(value, name, maximum = 2147483647) {
    if (typeof value !== "string" || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > maximum) {
        badQuery(`${name} must be a positive integer no greater than ${maximum}`);
    }
    return Number(value);
}

function timestamp(value) {
    const match = typeof value === "string" && value.match(/^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/);
    if (!match || !Number.isFinite(Date.parse(value)) || /T24:/.test(value)) return null;
    const [, year, month, day] = match.map(Number);
    const calendar = new Date(0);
    calendar.setUTCFullYear(year, month - 1, day);
    if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return null;
    return new Date(value);
}

function pagination(query) {
    const page = query.page === undefined ? 1 : positiveInteger(query.page, "page");
    const limit = query.limit === undefined ? 20 : positiveInteger(query.limit, "limit", 100);
    const skip = (page - 1) * limit;
    if (skip > 2147483647) badQuery("Requested page offset is too large");
    return { page, limit, skip };
}

function installationFilters(query) {
    const where = {};
    for (const name of ["provinceId", "districtId", "substationId"]) {
        if (query[name] !== undefined) {
            const id = positiveInteger(query[name], name);
            if (name === "substationId") where.substationId = id;
            if (name === "districtId") where.substation = { ...where.substation, districtId: id };
            if (name === "provinceId") where.substation = { ...where.substation, district: { provinceId: id } };
        }
    }
    return where;
}

function readingFilters(query, installationId) {
    const where = { installationId };
    for (const [name, operator] of [["from", "gte"], ["to", "lte"]]) {
        if (query[name] !== undefined) {
            const date = timestamp(query[name]);
            if (!date) badQuery(`${name} must be a valid ISO 8601 timestamp with a timezone`);
            where.timestamp = { ...where.timestamp, [operator]: date };
        }
    }
    if (where.timestamp?.gte > where.timestamp?.lte) badQuery("from must not be later than to");
    const sort = query.sort === undefined ? "asc" : query.sort;
    if (sort !== "asc" && sort !== "desc") badQuery("sort must be asc or desc");
    return { where, orderBy: [{ timestamp: sort }, { id: sort }] };
}

async function paginatedCollection(req, model, where, orderBy) {
    const { page, limit, skip } = pagination(req.query);
    const [count, data] = await Promise.all([
        model.count({ where }), model.findMany({ where, orderBy, skip, take: limit }),
    ]);
    function link(target) {
        const url = new URL(req.originalUrl, "http://localhost");
        url.searchParams.set("page", String(target));
        url.searchParams.set("limit", String(limit));
        return `${url.pathname}${url.search}`;
    }
    return {
        data, count, page, limit,
        next: skip + limit < count ? link(page + 1) : null,
        previous: page > 1 ? link(page - 1) : null,
    };
}

module.exports = { installationFilters, readingFilters, paginatedCollection, timestamp };
