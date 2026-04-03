# CitiBike Station Finder

Find the nearest Citi Bike stations with real-time e-bike availability, dock counts, and walking time estimates. Paid via MPP micropayments ($0.01/request).

**Live app:** [verify-sepolia.eigencloud.xyz](https://verify-sepolia.eigencloud.xyz/app/0xd7875b7d5e94062a3147A609A7D9f0fDA3b3ea1B)

## Quickstart

```bash
git clone https://github.com/mmurrs/citibike-api.git
cd citibike-api
npm install
npm start
```

Server runs on `http://localhost:8080`.

## Usage

```
GET /nearest?lat=40.7580&lng=-73.9855&limit=3
```

| Param | Required | Description |
|-------|----------|-------------|
| `lat` | yes | Latitude |
| `lng` | yes | Longitude |
| `limit` | no | Number of results (default 3, max 10) |

### Example Response

```json
{
  "results": [
    {
      "name": "W 42 St & 8 Ave",
      "distance_meters": 180,
      "walk_minutes": 2,
      "ebikes_available": 4,
      "bikes_available": 12,
      "docks_available": 8,
      "lat": 40.7575,
      "lng": -73.9903
    }
  ]
}
```

## Use with AgentCash

Install [AgentCash](https://agentcash.dev) in Claude Code:

```bash
npx agentcash@latest onboard
```

Then just ask Claude to find the nearest Citi Bike station.

## Docker

```bash
docker build -t citibike-api .
docker run -p 8080:3402 citibike-api
```

## License

MIT
