# Bearer authentication

Configure `JWT_SECRET` in the untracked `.env` with at least 32 bytes of randomly generated secret material. `.env.example` contains no real secret. Generate one locally, for example with `openssl rand -hex 48`. Never share this signing key with devices or analysts; provision signed, expiring tokens to them instead.

The API accepts HS256 tokens only and verifies signature, expiry, optional not-before, issuer (`JWT_ISSUER`, default `solar-generation`) and audience (`JWT_AUDIENCE`, default `solar-generation-api`). `sub` and `exp` are required. Requests use `Authorization: Bearer <token>`. Invalid/missing/expired tokens return 401 with `WWW-Authenticate`; insufficient scopes or jurisdiction return 403. Both use the existing `code/message/detail` error contract.

This is stateless resource-server authentication: tokens must be provisioned by a trusted signing authority. There is no public login, self-registration or token-minting endpoint. The existing User model is preserved; it is not a password database. No password fields, Device model, migration or security seed records are needed.

| Principal | Scope | Required claim | Access |
| --- | --- | --- | --- |
| Installation/device | `installation-write` | numeric `installationId` | POST `/installations/:installationId/readings` only for that installation |
| SLSEA district analyst | `analyst-read-by-district` | numeric `districtId` | GET/HEAD installation resources and readings within that district |
| Trusted hierarchy administrator | `hierarchy-admin` | none beyond identity/expiry | Hierarchy POST/PATCH/DELETE and installation reads across districts |

`scope` is a space-separated string. Device ingestion always requires `installation-write` and its matching installationId, including for tokens with administrative scope. Administrator scope is a separate privileged grant and must not be issued to district-only analysts.

Protected reads include `/installations`, `/installations/:installationId`, `/installations/:installationId/composite`, `/installations/:installationId/last-known-reading`, `/installations/:installationId/readings`, `/installations/:installationId/readings/:readingId` `/substations/:substationId/installations` and `/districts/:districtId/generation-summary`. Collection totals, navigation and results are constrained to the analyst's district even without an explicit filter. Requests explicitly targeting another jurisdiction return 403. Province/district/substation geography GETs and the root status page remain public.

All hierarchy write routes are protected. Authentication and jurisdiction checks precede resource retrieval and conditional GET, so an ETag cannot bypass access checks. Authenticated representations use `Cache-Control: private, no-cache` and `Vary: Authorization, Accept`.

Example payloads to provision with a trusted offline signer (issuer, audience, expiry and signature must also be supplied):

```json
{"sub":"installation:1","scope":"installation-write","installationId":1}
```

```json
{"sub":"slsea:analyst-123","scope":"analyst-read-by-district","districtId":1}
```

Regression tests mint short-lived tokens with randomly generated, process-local test keys and exercise the real authentication middleware. Security/write tests roll back all temporary readings/resources. Run `npm test` and `npm run seed:verify`.
