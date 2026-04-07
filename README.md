# FindMeACitiBike

Pick up a bike or find a dock. Real-time Citi Bike availability for NYC — $0.01/lookup via [Machine Payments Protocol](https://mpp.dev).

**API:** [citibike-mpp.vercel.app](https://citibike-mpp.vercel.app) · **OpenAPI:** [/openapi.json](https://citibike-mpp.vercel.app/openapi.json) · **Verification:** [EigenCompute](https://verify-sepolia.eigencloud.xyz/app/0xd7875b7d5e94062a3147A609A7D9f0fDA3b3ea1B)

## Quickstart

```bash
git clone https://github.com/mmurrs/FindMeACitiBike.git
cd FindMeACitiBike
npm install
npm start
```

Server runs on `http://localhost:8080`.

## What you can ask

- "Find me a Citi Bike near Bedford Ave — I'm heading to SoHo"
- "Any e-bikes near the L train in Williamsburg?"
- "I'm at the WeWork in Flatiron, where can I dock?"
- "Where can I park near Broadway and Houston?"

Your agent handles the location lookup, API call, and payment automatically.

## Use with AgentCash

```bash
npx agentcash add https://citibike-mpp.vercel.app
```

## Endpoints

Two endpoints, $0.01 each via [Machine Payments Protocol](https://mpp.dev).

**Pick up a bike** — `GET /nearest?lat=...&lng=...&limit=3`
Returns nearest stations with available bikes, e-bikes, and walking time.

**Park a bike** — `GET /dock?lat=...&lng=...&limit=3`
Returns nearest stations with open docks.

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

## Docker

```bash
docker build -t findmeacitibike .
docker run -p 8080:8080 findmeacitibike
```

## License

MIT
