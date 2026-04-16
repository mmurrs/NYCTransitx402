# Real Time NYC Transit

## What this is
Real-time NYC transit API for AI agents. Citi Bike, Subway, Bus — $0.02/check via MPP or x402.
Deployed as a verifiable service on EigenCloud.

## Architecture
- `server.js` — Express entry point, imports `dual402.js` for payment middleware
- `dual402.js` — Dual payment middleware accepting both x402 (Base) and MPP
- `data/subway-stations.json` — 496 stations with lat/lng/lines/feeds (generated from MTA static GTFS)
- `proxy/` — Vercel deployment (static landing page + API proxy to backend)

## Endpoints
- `GET /citibike/nearest` — bikes available (GBFS from Lyft, 60s cache)
- `GET /citibike/dock` — docks available
- `GET /subway/nearest` — real-time train arrivals (MTA GTFS-RT, 30s cache, no API key)
- `GET /bus/nearest` — real-time bus predictions (MTA SIRI, requires MTA_BUS_API_KEY)
- `GET /openapi.json` — auto-generated from dual402 discovery
- `GET /.well-known/x402` — x402 payment discovery
- `GET /skill.md` — agent skill definition
- `GET /llms.txt` — agent-facing docs

## Key patterns
- **Dual payment**: Every paid endpoint accepts BOTH x402 and MPP. The `dual402.js` middleware handles this. Don't break this — both protocols must work on every route.
- **Terminology**: Use "check" not "lookup" — this was standardized across all surfaces.
- **Pricing**: $0.02 per check. Change in `server.js` charge definitions, then grep for `0.02` across index.html, llms.txt, og.svg, proxy/public/* to update all surfaces.
- **Landing page sync**: `index.html` and `proxy/public/index.html` MUST stay in sync. After editing index.html, always copy to proxy/public/index.html.

## dual402.js internals
- Factory pattern: `createDual402({ mpp, x402 })` creates the handler, `.charge({ amount, description })` creates per-route middleware
- **Core pattern**: Intercepts `res.status(402)` to inject x402 `PAYMENT-REQUIRED` header alongside mppx's `WWW-Authenticate`. Do NOT try to chain the middlewares separately — the first one to see no credential returns 402 and blocks the second.
- x402 verification: Decodes `PAYMENT-SIGNATURE` (v2) or `X-PAYMENT` (v1) header, validates amount/payee locally, then POSTs to facilitator `/verify` and `/settle`.
- MPP: Delegates entirely to mppx Express middleware for both credential verification and challenge generation.
- `_dualAmount` is stashed on each handler so discovery can read the price.

## Environment variables
Copy `.env.example` and fill in your values.

Variables:
- `MPP_SECRET_KEY` — mppx HMAC key (generate a random 64-char hex string)
- `USDC_TEMPO` — USDC token address for MPP settlement
- `RECIPIENT_WALLET` — default payment recipient wallet for both protocols
- `MPP_RECIPIENT` — MPP-specific recipient (overrides RECIPIENT_WALLET for MPP)
- `MPP_TESTNET` — set to `"true"` for testnet
- `MTA_BUS_API_KEY` — MTA bus SIRI API key (get one at https://api.mta.info)
- `X402_PAYEE_ADDRESS` — x402 payment recipient on Base (overrides RECIPIENT_WALLET for x402)
- `X402_NETWORK` — CAIP-2 chain ID (`eip155:84532` = Base Sepolia, `eip155:8453` = Base mainnet)
- `X402_FACILITATOR_URL` — testnet: `https://x402.org/facilitator`, mainnet: `https://api.cdp.coinbase.com/platform/v2/x402`
- `BASE_URL` — optional override for resource URLs in payment challenges (useful behind proxies)
- `BACKEND_URL` — (proxy only) backend server URL for the Vercel proxy

## Deployment
- **Backend**: Deploy to EigenCloud or any Node.js host. Set env vars and run `node server.js`.
- **Proxy/Landing page**: Deploy the `proxy/` directory to Vercel. Set `BACKEND_URL` to your backend address.

## Data sources
- **Citi Bike**: Lyft GBFS feeds (no auth, 60s cache TTL) — CC0 public domain
- **Subway**: MTA GTFS-RT protobuf feeds (no auth, 30s cache TTL, 8 separate feeds by line group)
- **Bus**: MTA SIRI JSON API (requires API key, real-time predictions per stop)
- Transit data provided by the MTA and CitiBike. Data may not be accurate, complete, or current. Not affiliated with or endorsed by the MTA or CitiBike.
