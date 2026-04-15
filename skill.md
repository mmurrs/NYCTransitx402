# FindMeA — NYC Transit Skill

Use this skill to help users find real-time NYC transit options: Citi Bike stations, subway arrivals, and bus predictions.

## What FindMeA does

FindMeA provides real-time transit data for New York City across three modes:
- **Citi Bike**: Find available bikes or open docks with e-bike counts and walking times
- **Subway**: Get live train arrivals for 496 stations across all 26 MTA lines
- **Bus**: Real-time bus arrival predictions with routes and destinations

All lookups cost $0.02 via MPP or x402. Both payment protocols are accepted on every endpoint.

## Prerequisites

The agent needs a compatible payment method (any one):
- **AgentCash**: Run `npx agentcash onboard` — handles both MPP and x402 automatically
- **MPP**: Use the `mppx` client library with a Tempo wallet
- **x402**: Use `@x402/fetch` with a Base wallet holding USDC

## Endpoints

### Citi Bike — Pick up a bike
```
GET /citibike/nearest?lat={latitude}&lng={longitude}&limit={count}
```

Returns nearest stations with available bikes. Includes classic bikes, e-bikes, and dock counts.

**Response:**
```json
{
  "results": [
    {
      "name": "Bedford Ave & N 7 St",
      "distance_feet": 279,
      "walk_minutes": 1,
      "ebikes_available": 3,
      "bikes_available": 11,
      "docks_available": 6,
      "lat": 40.7184,
      "lng": -73.9572
    }
  ]
}
```

### Citi Bike — Park a bike
```
GET /citibike/dock?lat={latitude}&lng={longitude}&limit={count}
```

Returns nearest stations with available docks for parking. Only includes stations accepting returns.

### Subway — Next train
```
GET /subway/nearest?lat={latitude}&lng={longitude}&limit={count}
```

Returns nearest subway stations with live train arrivals. Data updated every 30 seconds from MTA GTFS-RT feeds.

**Response:**
```json
{
  "results": [
    {
      "name": "Bedford Ave",
      "distance_feet": 350,
      "walk_minutes": 1,
      "lines": ["L"],
      "arrivals": [
        { "line": "L", "direction": "Uptown", "minutes": 3 },
        { "line": "L", "direction": "Downtown", "minutes": 7 }
      ],
      "lat": 40.7172,
      "lng": -73.9567
    }
  ]
}
```

### Bus — Next bus
```
GET /bus/nearest?lat={latitude}&lng={longitude}&limit={count}
```

Returns nearest bus stops with real-time arrival predictions from MTA SIRI feeds.

**Response:**
```json
{
  "results": [
    {
      "name": "Broadway & Houston St",
      "distance_feet": 180,
      "walk_minutes": 0,
      "routes": ["M1", "M55"],
      "arrivals": [
        { "route": "M1", "destination": "Harlem", "minutes": 2 },
        { "route": "M55", "destination": "South Ferry", "minutes": 5 }
      ],
      "lat": 40.7252,
      "lng": -73.9967
    }
  ]
}
```

## Parameters (all endpoints)

- `lat` (required): Latitude coordinate (e.g., 40.7252)
- `lng` (required): Longitude coordinate (e.g., -73.9967)
- `limit` (optional): Number of results to return (default: 3, max: 10)

## Workflow

1. **Resolve location**: When the user mentions a place name (e.g., "Bedford Ave", "Union Square"), use a geocoding service to get lat/lng coordinates first. NEVER skip this step.

2. **Choose endpoint**: Determine which transit mode(s) the user needs:
   - Looking for a bike → `/citibike/nearest`
   - Need to park a bike → `/citibike/dock`
   - Taking the subway → `/subway/nearest`
   - Taking the bus → `/bus/nearest`
   - Comparing options → call multiple endpoints

3. **Call the API**: Make the request with lat/lng coordinates. Payment is handled automatically via MPP or x402.

4. **Present results**: Format the response for the user:
   - Show walking times prominently ("1 min walk")
   - For bikes: mention e-bike availability if present
   - For subway: show next 3 arrivals with line and direction
   - For bus: show route numbers and destinations
   - Always include distance information

## Rules

- **Always resolve place names to coordinates first** — the API only accepts lat/lng
- **Use limit=3 by default** — only increase if the user asks for more options
- **Present walking times** — users care about "how far" more than distance in feet
- **Handle multi-modal questions** — if the user asks "should I bike or take the subway?", call both endpoints and compare
- **Explain availability** — if no bikes/docks are available, mention it clearly
- **Show next few arrivals** — for subway/bus, present the next 2-3 options so users can plan
- **USDC wallet required** — if payment fails, tell the user to run `npx agentcash onboard` (supports both MPP and x402)

## Example prompts

Users might say:
- "Find me a Citi Bike near Bedford Ave"
- "When's the next L train at Union Square?"
- "Should I bike or take the subway from Williamsburg to SoHo?"
- "Where can I dock near the WeWork in Flatiron?"
- "Is there a bus near Broadway and Houston?"
- "I'm running late — what's the fastest way to get there?"

## Resources

- OpenAPI spec: https://findmea-nyc.vercel.app/openapi.json
- Documentation: https://findmea-nyc.vercel.app/llms.txt
- GitHub: https://github.com/mmurrs/findmea
- AgentCash: https://agentcash.dev
- MPP: https://mpp.dev
- x402: https://x402.org
- x402 Discovery: https://findmea-nyc.vercel.app/.well-known/x402
