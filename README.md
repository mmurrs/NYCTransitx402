# FindMeA — NYC Transit API

Real-time NYC transit for agents. Citi Bike stations, subway arrivals, and bus predictions — $0.01/lookup via [Machine Payments Protocol](https://mpp.dev).

**API:** [findmea-nyc.vercel.app](https://findmea-nyc.vercel.app) · **OpenAPI:** [/openapi.json](https://findmea-nyc.vercel.app/openapi.json)

## Quickstart

```bash
git clone https://github.com/mmurrs/findmea.git
cd findmea
npm install
npm start
```

Server runs on `http://localhost:8080`.

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
npx agentcash add https://findmea-nyc.vercel.app
```

## Endpoints

Five endpoints, $0.01 each via [Machine Payments Protocol](https://mpp.dev).

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

## Docker

```bash
docker build -t findmea .
docker run -p 8080:8080 findmea
```

## License

MIT
