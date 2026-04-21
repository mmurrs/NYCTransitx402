# Invariants

Properties the system must uphold at all times. Each invariant has an ID, a
one-line statement, and the test that enforces it. If you add a new feature,
either prove it doesn't break these, or add a new invariant and a new test.

## Payment (the part where we can't afford to be wrong)

| ID  | Invariant | Enforced by |
|-----|-----------|-------------|
| P1  | Paid routes never return 200 without a verified payment (x402 OR MPP). | `tests/invariants.test.mjs::payment.unauth returns 402` |
| P2  | Every 402 response carries both `PAYMENT-REQUIRED` (x402) and `WWW-Authenticate` (MPP) headers. A client can't be forced to pick a protocol before seeing the offer. | `tests/invariants.test.mjs::payment.402 carries both headers` |
| P3  | The `PAYMENT-REQUIRED` base64 payload decodes to x402 v2 with `amount`, `asset`, `payTo`, `network` all matching server config, and `resource` normalized to `${BASE_URL}<path>` (no query-string drift). | `tests/invariants.test.mjs::payment.x402 challenge matches config` |
| P4  | A forged `PAYMENT-SIGNATURE` with wrong amount is rejected locally, never reaches the facilitator. | `tests/invariants.test.mjs::payment.wrong amount rejected locally` |
| P5  | A forged `PAYMENT-SIGNATURE` with wrong payee is rejected locally, never reaches the facilitator. | `tests/invariants.test.mjs::payment.wrong payee rejected locally` |
| P6  | A `PAYMENT-SIGNATURE` missing the `amount` field is rejected (no "field absent = wave through"). | `tests/invariants.test.mjs::payment.missing amount rejected` |
| P7  | A `PAYMENT-SIGNATURE` missing the `payTo` field is rejected. | `tests/invariants.test.mjs::payment.missing payee rejected` |
| P8  | Facilitator `/verify` and `/settle` calls time out at `X402_FACILITATOR_TIMEOUT_MS` (default 5s). A hung facilitator does not hang requests. | `dual402.smoke.mjs` (offline) + documented default |
| P9  | Missing required payment env (`MPP_SECRET_KEY`, `USDC_TEMPO`, recipient wallet config) causes the server to exit at boot with a clear error. Never silent misconfiguration. | `tests/invariants.test.mjs::boot.missing env fails fast` |
| P10 | A zero or negative `amount` on a charge route is rejected at construction. No silently-free routes. | `dual402.smoke.mjs::rejects zero/negative amount` |
| P11 | The MPP `WWW-Authenticate` challenge realm matches `MPP_REALM` when set, otherwise the host portion of `BASE_URL`, so registries never see an internal container hostname. | `tests/dual402.smoke.mjs::MPP realm` |

## Discovery

| ID  | Invariant | Enforced by |
|-----|-----------|-------------|
| D1  | `/.well-known/x402` is the exact minimal v1 fallback shape: `{ "version": 1, "resources": ["POST /path", ...] }` covering every paid canonical route. | `tests/invariants.test.mjs::discovery.well-known/x402 shape` |
| D2  | `/openapi.json` is canonical discovery: OpenAPI 3.1.0, POST-only paid operations, JSON request bodies, JSON response schemas, and `info.x-guidance`. | `tests/invariants.test.mjs::discovery.openapi uses POST schemas` |
| D3  | Every paid OpenAPI operation exposes `x-payment-info.price` in fixed-price shape plus both protocol descriptors (`x402`, `mpp`) and a `402` response. | `tests/invariants.test.mjs::discovery.openapi payment metadata` |
| D4  | The fixed USD amount in `/openapi.json` matches the raw `amount` advertised in the runtime `PAYMENT-REQUIRED` challenge for the same route. | `tests/invariants.test.mjs::discovery.price consistency` |
| D5  | Canonical POST routes still return `402` on an unpaid probe with an empty body, so discovery scanners can verify payment behavior before they know the request payload. | `tests/invariants.test.mjs::discovery.empty POST probe returns 402` |
| D6  | Runtime x402 challenge descriptions are route-specific and informative, so registries/scanners can distinguish pickup vs dock vs subway vs bus checks. | `tests/invariants.test.mjs::discovery.runtime descriptions distinguish endpoints` |

## Data / correctness

| ID  | Invariant | Enforced by |
|-----|-----------|-------------|
| C1  | Invalid `lat`/`lng` on the legacy/manual query-string surface returns 400, not 500/502/402. | `tests/invariants.test.mjs::validation.bad lat/lng → 400` |
| C2  | `limit` is bounds-checked on the legacy/manual query-string surface: integer 1–10 or absent. | `tests/invariants.test.mjs::validation.limit bounds` |
| C3  | `/bus/nearest` returns 503 (not 500) when `MTA_BUS_API_KEY` is absent. | `tests/invariants.test.mjs::bus.503 without key` |

## Operational

| ID  | Invariant | Enforced by |
|-----|-----------|-------------|
| O1  | No log line contains `MPP_SECRET_KEY`, `MTA_BUS_API_KEY`, a full `PAYMENT-SIGNATURE`, or a private key. | Manual review; `dual402.js` log calls only use sanitized fields. |
| O2  | CORS exposes `PAYMENT-REQUIRED` and `WWW-Authenticate` so browser clients can read the challenge. | `tests/invariants.test.mjs::cors.exposes payment headers` |
| O3  | Cache TTLs are bounded (GBFS=60s, GTFS=30s). No unbounded in-memory growth across requests. | Code review; `fetchGBFS` has `GBFS_TTL`, `fetchFeed` has `FEED_TTL` per-feed. |
| O4  | The `res.status` monkey-patch is per-request and cannot leak to other requests. | Express gives a fresh `res` per request; patched closure captures per-request `paymentRequired` only. |

## How to run

```bash
# Offline smoke (no network, no server boot): ~1s
node tests/dual402.smoke.mjs

# Full invariant suite (boots server with .env.test, hits routes): ~5s
node --test tests/invariants.test.mjs
```

Both must pass on every change to `dual402.js` or `server.js`.

## When to add a new invariant

- You wrote a test for a bug fix. Promote it to an invariant so the bug can't come back silently.
- You made a trade-off in code and want to encode it as a rule (e.g. "settlement is async"). Document the trade-off here, and if reasonable, test the user-visible behavior.
- You added a new endpoint. P1–P7 and O1–O2 now apply to it; add it to the test suite.

## When to remove or change an invariant

Only when the user-observable contract is intentionally changing. Don't loosen an invariant to make a test pass — figure out why the behavior regressed first.
