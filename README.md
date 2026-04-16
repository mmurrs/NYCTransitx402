# NYC Transit Live

Real-time NYC transit for agents. Citi Bike stations, subway arrivals, and bus predictions — $0.02/check via [MPP](https://mpp.dev) or [x402](https://x402.org).

**OpenAPI:** [/openapi.json](https://findmea-nyc.vercel.app/openapi.json) · **x402:** [/.well-known/x402](https://findmea-nyc.vercel.app/.well-known/x402)

## Quickstart

```bash
git clone https://github.com/mmurrs/NYCTransitLive-x402.git
cd NYCTransitLive-x402
cp .env.example .env   # fill in your values
npm install
npm start
```

Server runs on `http://localhost:8080`. See `.env.example` for required environment variables.

## Things you can say

- "Find me a Citi Bike near Bedford Ave — I'm heading to SoHo"
- "When's the next L train at Union Square?"
- "Should I bike or take the subway from Williamsburg to SoHo?"
- "Where can I dock near the WeWork in Flatiron?"
- "Is there a bus near Broadway and Houston?"
- "I'm running late — what's the fastest way to get there?"

Your agent handles the location lookup, API call, and payment automatically.

## Use with AgentCash

```bash
npx agentcash add <YOUR_BACKEND_URL>
```

## Endpoints

Four endpoints, $0.02 each via [MPP](https://mpp.dev) or [x402](https://x402.org). Both protocols accepted on every route.

### Bike

**Pick up a bike** — `GET /citibike/nearest?lat=...&lng=...&limit=3`
Returns nearest stations with available bikes, e-bikes, and walking time.

**Park a bike** — `GET /citibike/dock?lat=...&lng=...&limit=3`
Returns nearest stations with open docks.

### Subway

**Next train** — `GET /subway/nearest?lat=...&lng=...&limit=3`
Returns nearest stations with real-time arrivals — line, direction, and minutes until departure. 496 stations, 26 lines, GTFS-RT feeds updated every 30 seconds.

### Bus

**Next bus** — `GET /bus/nearest?lat=...&lng=...&limit=3`
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

The main files you'll want to look at:

- **`server.js`** — Express routes and data source logic (GBFS, GTFS-RT, SIRI)
- **`dual402.js`** — Payment middleware (x402 + MPP). Both protocols must work on every route.
- **`index.html`** — Landing page (single file, inline CSS). Must be synced to `proxy/public/index.html` after changes.
- **`data/subway-stations.json`** — Static station data (496 stations with lat/lng/lines/feeds)

## Data Sources

Transit data provided by the MTA and CitiBike. Data may not be accurate, complete, or current. This service is not affiliated with or endorsed by the MTA or CitiBike.

## License

MIT
