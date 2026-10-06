# Development seed

This seed uses the existing CommonJS Prisma 7 client in `prisma/client.js`. It does not change the schema, add devices, create users, or implement endpoints.

With `DATABASE_URL` pointing at your development database and the existing schema already applied:

```sh
npm run prisma:generate
npm run seed
npm run seed:verify
```

If this is a new, empty database without tables, apply the existing schema first with `npx prisma db push`. No reset or destructive migration is needed.

Expected counts on an initially empty database:

| Entity | Count |
| --- | ---: |
| Province | 9 |
| District | 25 |
| GridSubstation | 25 |
| SolarInstallation | 200 |
| GenerationReading | 134,400 |
| User | 0 |

There is one explicitly synthetic `Demo … Grid Substation` per district and eight installations per substation. Meter identifiers remain `SolarInstallation.meterId`. Provinces and districts use the Sri Lankan administrative hierarchy; synthetic substation names are not an official infrastructure inventory.

The fixed window is January 1–7, 2026 in Asia/Colombo (+05:30), with 672 readings per installation. Timestamps are stored as UTC instants, starting December 31, 2025 at 18:30 UTC and ending January 7, 2026 at 18:15 UTC. Simulated 3–20 kW installations generate no power overnight, with a smooth 06:00–18:00 daylight curve, midday peaks and deterministic daily cloud variation. Voltage stays near 230 V, including overnight because these are grid-connected meters. Cumulative kWh starts at zero and integrates power across the entire seven-day window without resetting at midnight.

Reruns append missing fixture records and preserve matching existing readings. They never update or delete readings. A single transaction rolls back the entire run on error. A PostgreSQL advisory transaction lock serializes concurrent runs of this seed; it does not coordinate unrelated applications writing to the same fixture meters. Stable meter IDs and timestamps identify the fixtures. Conflicting hierarchy or reading values cause an error rather than overwriting data. Unexpected provinces/districts are rejected to preserve the exact 9/25 requirement; unrelated substations, installations, users, and readings outside the fixture window remain untouched. As a result, total database counts can exceed fixture counts after other data is added.

Readings are inserted with `createMany` in batches of 2,000, within a three-minute transaction timeout. No uniqueness constraint is added to the append-only reading model.

`npm run seed:verify` prints all six table counts and verifies every fixture reading, its timestamp, values and parent hierarchy. `npm run seed:test` checks generation independently of database availability.

References: [Sri Lanka Survey Department administrative map](https://survey.gov.lk/sdweb/pdf/latestpost/Recalculation%20of%20Country%20Extent.pdf), [Prisma 7 seeding configuration](https://www.prisma.io/docs/orm/v7/prisma-migrate/workflows/seeding).
