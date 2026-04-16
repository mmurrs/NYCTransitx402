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

## Environment variables (.env)
- `MPP_SECRET_KEY` — mppx HMAC key
- `USDC_TEMPO` — Tempo USDC token address
- `MPP_RECIPIENT` — MPP payment recipient wallet
- `MTA_BUS_API_KEY` — MTA bus SIRI API key (free, from register.developer.obanyc.com)
- `X402_PAYEE_ADDRESS` — x402 payment recipient (Base wallet)
- `X402_NETWORK` — x402 chain (eip155:84532 = Base Sepolia)
- `X402_FACILITATOR_URL` — x402 facilitator endpoint

## Git workflow
Push directly to main, no PRs. This is a personal project.

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
