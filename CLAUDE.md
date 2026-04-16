# FindMeA — NYC Transit API

## What this is
Real-time NYC transit API for AI agents. Citi Bike, Subway, Bus — $0.02/check via MPP or x402.
Live at https://findmea-nyc.vercel.app. GitHub: mmurrs/findmea (private).

## Architecture
- `server.js` — Express entry point, imports `dual402.js` for payment middleware
- `dual402.js` — Dual payment middleware accepting both x402 (Base Sepolia) and MPP (Tempo USDC)
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
- **Pricing**: $0.02 per check. Change in `server.js` charge definitions, then grep for `0.02` across index.html, llms.txt, README.md, og.svg, proxy/public/* to update all surfaces.
- **Landing page sync**: `index.html` and `proxy/public/index.html` MUST stay in sync. After editing index.html, always copy to proxy/public/index.html.
- **Vercel deploy**: Pushing to git does NOT auto-deploy. Run `cd proxy && npx vercel --prod` to deploy.
- **Backend deploy**: The Vercel proxy forwards API requests to the backend server. Backend IP is configured in `proxy/api/[...path].js` via BACKEND_URL env var (fallback hardcoded).

## dual402.js internals
- Factory pattern: `createDual402({ mpp, x402 })` creates the handler, `.charge({ amount, description })` creates per-route middleware
- **Core pattern**: Intercepts `res.status(402)` to inject x402 `PAYMENT-REQUIRED` header alongside mppx's `WWW-Authenticate`. Do NOT try to chain the middlewares separately — the first one to see no credential returns 402 and blocks the second.
- x402 verification: Decodes `PAYMENT-SIGNATURE` (v2) or `X-PAYMENT` (v1) header, validates amount/payee locally, then POSTs to facilitator `/verify` and `/settle`. No @x402/express dependency — the facilitator does all the work.
- MPP: Delegates entirely to mppx Express middleware for both credential verification and challenge generation.
- Discovery hack: `dualDiscovery()` creates shadow mppx charge handlers for `/openapi.json` because mppx's `discovery()` reads `_internal` metadata from its own handlers. Our dual handlers don't have it. Fragile — clean up for open-source.
- `_dualAmount` is stashed on each handler so discovery can read the price.

## Environment variables
Three env files exist:
- `.env` — production config (mainnet Tempo USDC). Used by ecloud deploy (default).
- `.env.test` — local testing (testnet PathUSD + `MPP_TESTNET=true`). Used by `test-dual402.sh`.
- `.env.ecloud` — production + x402 vars explicitly set. Used for ecloud upgrade with `--env-file`.

Variables:
- `MPP_SECRET_KEY` — mppx HMAC key
- `USDC_TEMPO` — Tempo USDC token address (mainnet: `0x20C0...b9537d11c60E8b50`, testnet: `0x20c0...0000`)
- `RECIPIENT_WALLET` — default payment recipient wallet for both protocols. Per-network overrides take precedence: MPP resolves `MPP_RECIPIENT || RECIPIENT_WALLET || RECIPIENT`, x402 resolves `X402_PAYEE_ADDRESS || RECIPIENT_WALLET`.
- `MPP_RECIPIENT` or `RECIPIENT` — MPP payment recipient wallet (both names accepted, backwards compat). Overrides `RECIPIENT_WALLET` for MPP.
- `MPP_TESTNET` — set to `"true"` for Tempo testnet (chain 42431 instead of 4217)
- `MTA_BUS_API_KEY` — MTA bus SIRI API key
- `X402_PAYEE_ADDRESS` — x402 payment recipient (Base wallet). Overrides `RECIPIENT_WALLET` for x402.
- `X402_NETWORK` — CAIP-2 chain ID (`eip155:84532` = Base Sepolia, `eip155:8453` = Base mainnet)
- `X402_FACILITATOR_URL` — testnet: `https://x402.org/facilitator`, mainnet: `https://api.cdp.coinbase.com/platform/v2/x402`
- `BASE_URL` — optional override for resource URLs in payment challenges (useful behind proxies)

## Testing locally
```bash
./test-dual402.sh          # Headers + discovery only
./test-dual402.sh --mpp    # + MPP payment via npx mppx (testnet, auto-funded)
./test-dual402.sh --x402 0xKEY  # + x402 payment (needs Base Sepolia USDC from faucet.circle.com)
```
The script auto-detects `.env.test` and uses it. MPP tests require testnet config because mppx CLI wallets are funded with PathUSD, not mainnet USDC.

## Mainnet x402 (when ready)
Zero code changes. Two env var changes:
- `X402_NETWORK=eip155:8453`
- `X402_FACILITATOR_URL=https://api.cdp.coinbase.com/platform/v2/x402`
Base mainnet USDC address is already in `dual402.js` USDC_BY_NETWORK map.

## Deployment
- **ecloud** (backend): `ecloud compute app upgrade <APP_ID> --environment sepolia --env-file .env.ecloud`
  - App ID: `0xc4eb6dD8aF1dEF5D6daa1320261fE9A1A447C4e5`
  - IP: `34.21.141.59:8080`
  - IMPORTANT: `--env-file` flag is buggy (RND-547) — use `export ECLOUD_ENVFILE_PATH=...` env var or ensure the command is on ONE line
  - `trust proxy` is enabled in Express for correct protocol detection behind ecloud
- **Vercel** (proxy/landing page): `cd proxy && npx vercel --prod`

## Git workflow
Push directly to main, no PRs. This is a personal project.
Branch `feat/dual-402` has all dual-protocol work — merge to main when validated.

## Branding
- Brand: **FindMeA** — transit modes are Bike (#0073CE), Subway (#FF6319), Bus (#00ADD0)
- Subway lines use actual MTA colors as 22px circle pills
- Inspired by StableEnrich/AgentRes patterns but differentiated by transit-specific colors and prompt→response UX
- OG images, meta tags, README, llms.txt, skill.md must all stay consistent when branding changes

## Frontend
- Single HTML file (index.html), no build step, inline CSS
- Inter + JetBrains Mono fonts
- Use the `fullstack-web-developer` agent for any frontend/design work
- Landing page has wallet tabs (AgentCash / Privy / Tempo) for the Get Started section
- Runs on EigenCloud (verify badge in hero links to EigenCloud dashboard)

## Data sources
- **Citi Bike**: Lyft GBFS feeds (no auth, 60s cache TTL)
- **Subway**: MTA GTFS-RT protobuf feeds (no auth, 30s cache TTL, 8 separate feeds by line group)
- **Bus**: MTA SIRI JSON API (requires API key, real-time predictions per stop)
