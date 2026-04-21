# NYC Transit Live

Real-time NYC transit for agents. Citi Bike stations, subway arrivals, and bus predictions — $0.02/check via [MPP](https://mpp.dev) or [x402](https://x402.org).

**OpenAPI:** [/openapi.json](https://transit402.dev/openapi.json) · **x402 fallback:** [/.well-known/x402](https://transit402.dev/.well-known/x402)

## Quickstart

```bash
git clone https://github.com/mmurrs/NYCTransitx402.git
cd NYCTransitx402
cp .env.example .env   # fill in your values
npm install
npm start
```

Server runs on `http://localhost:8080`. See `.env.example` for required environment variables.

Canonical agent discovery uses `POST` JSON bodies with `{ "lat": ..., "lng": ..., "limit": ... }`. The legacy `GET` query-string routes remain supported for manual and browser use.

If you deploy behind a public proxy or custom domain, set `BASE_URL` to the public origin and `MPP_REALM` to the public hostname so x402 resource URLs and MPP `WWW-Authenticate` challenges both match the external service identity.

## Things you can say

- "I'm in SoHo — where are the closest e-bikes?"
- "Where's the nearest Manhattan-bound L train from Bedford Ave?"
- "Which Citi Bike stations near Union Sq have 5+ e-bikes right now?"
- "I'm leaving McCarren to West Village — I'll bike home if e-bikes are within 8 min, or I'll take the L"

Your agent handles the location lookup, API call, and payment automatically. See live demos of each prompt at [transit402.dev](https://transit402.dev).

## Use with AgentCash

```bash
npx agentcash add https://transit402.dev
```

## Endpoints

Four endpoints, $0.02 each via [MPP](https://mpp.dev) or [x402](https://x402.org). Both protocols accepted on every route.

### Bike

**Pick up a bike** — `POST /citibike/nearest`
Returns nearest stations with available bikes, e-bikes, and walking time.

**Park a bike** — `POST /citibike/dock`
Returns nearest stations with open docks.

### Subway

**Next train** — `POST /subway/nearest`
Returns nearest stations with real-time arrivals — line, direction, and minutes until departure. 496 stations, 26 lines, GTFS-RT feeds updated every 30 seconds.

**Service alerts** — `POST /subway/alerts`
Active MTA service alerts — severity bucket (`delays`, `no_service`, `reduced`, `detour`, `info`), direction (`both`, `Uptown`, `Downtown`), and `estimated_minutes` extracted from the alert description when the MTA includes them. Optional `lines` filter.

### Bus

**Next bus** — `POST /bus/nearest`
Returns nearest stops with real-time arrival predictions — route, destination, ETA, and stops away.

## Example responses

### /citibike/nearest

```json
{
  "results": [{
    "name": "Bedford Ave & N 7 St",
    "distance_feet": 279,
    "walk_minutes": 1,
    "ebikes_available": 3,
    "bikes_available": 11,
    "docks_available": 6
  }]
}
```

### /subway/nearest

```json
{
  "results": [{
    "name": "14 St-Union Sq",
    "distance_feet": 159,
    "walk_minutes": 0,
    "lines": ["N", "Q", "R", "W"],
    "arrivals": [
      { "line": "Q", "direction": "Uptown", "minutes": 1 },
      { "line": "W", "direction": "Uptown", "minutes": 3 },
      { "line": "R", "direction": "Downtown", "minutes": 4 }
    ]
  }]
}
```

## Deploy to EigenCloud

This service is designed to run as a verifiable agent service on [EigenCloud](https://eigencloud.xyz). Deploy with the `ecloud` CLI:

```bash
ecloud compute app create --env-file .env
```

The included `Dockerfile` handles the build. Set `BACKEND_URL` in your Vercel proxy to point to the deployed backend.

## Contributing

PRs welcome. The main files:

- `**server.js**` — Express routes and data source logic (GBFS, GTFS-RT, SIRI)
- `**dual402.js**` — Payment middleware (x402 + MPP). Both protocols must work on every route.
- `**proxy/public/index.html**` — Landing page (single file, inline CSS, served at the Vercel edge)
- `**data/subway-stations.json**` — Static station data (496 stations with lat/lng/lines/feeds)
- `**INVARIANTS.md**` — What the system must always do. Run `npm test` before merging.

## Data Sources

Transit data provided by the MTA and Citi Bike. Data may not be accurate, complete, or current. This service is not affiliated with or endorsed by the MTA or Citi Bike.

## Source

This repo is public for transparency and to allow contributions. Source is not licensed for redistribution or commercial reuse. © 2026 Matt Murray, all rights reserved.