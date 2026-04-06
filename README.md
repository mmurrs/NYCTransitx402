# CitiBike Station Finder

Find the nearest Citi Bike stations to pick up a bike or park one. Real-time e-bike availability, dock counts, and walking time estimates. Paid via Machine Payments Protocol micropayments ($0.01/request).

**API:** [citibike-mpp.vercel.app](https://citibike-mpp.vercel.app) · **OpenAPI:** [/openapi.json](https://citibike-mpp.vercel.app/openapi.json) · **Verification:** [EigenCompute](https://verify-sepolia.eigencloud.xyz/app/0xd7875b7d5e94062a3147A609A7D9f0fDA3b3ea1B)

## Quickstart

```bash
git clone https://github.com/mmurrs/citibike-api.git
cd citibike-api
npm install
npm start
```

Server runs on `http://localhost:8080`.

## Endpoints

### Pick up a bike

```
GET /nearest?lat=40.7184&lng=-73.9572&limit=3
```

```json
{
  "results": [{
    "name": "Bedford Ave & N 7 St",
    "distance_meters": 85,
    "walk_minutes": 1,
    "ebikes_available": 3,
    "bikes_available": 11,
    "docks_available": 6
  }]
}
```

### Park a bike

```
GET /dock?lat=40.7415&lng=-73.9940&limit=3
```

```json
{
  "results": [{
    "name": "W 21 St & 6 Ave",
    "distance_meters": 140,
    "walk_minutes": 2,
    "docks_available": 9,
    "bikes_available": 15
  }]
}
```

### Params

| Param | Required | Description |
|-------|----------|-------------|
| `lat` | yes | Latitude |
| `lng` | yes | Longitude |
| `limit` | no | Number of results (default 3, max 10) |

$0.01 per request via [Machine Payments Protocol](https://mpp.dev).

## Use with AgentCash

Install [AgentCash](https://agentcash.dev) in Claude Code:

```bash
npx agentcash@latest onboard
```

Then just ask Claude:

- "Find me a Citi Bike near Bedford Ave — I'm heading to SoHo"
- "I'm at the WeWork in Flatiron, where can I dock?"

## Docker

```bash
docker build -t citibike-api .
docker run -p 8080:8080 citibike-api
```

## License

MIT
