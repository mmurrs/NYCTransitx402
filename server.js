import express from "express";
import { Mppx, tempo, discovery } from "mppx/express";

const app = express();
const PORT = process.env.PORT || 8080;

const USDC_TEMPO = "0x20C000000000000000000000b9537d11c60E8b50";
const RECIPIENT = "0x7a38788e020644Dd377a5C0F0E1D9f3e3A467369";

const mppx = Mppx.create({
  methods: [tempo.charge({ currency: USDC_TEMPO, recipient: RECIPIENT })],
  secretKey: process.env.MPP_SECRET_KEY || "citibike-dev-secret",
});

// Create the payment middleware so we can reference it in both the route and discovery
const chargeNearest = mppx.charge({
  amount: "0.01",
  description: "Citi Bike nearest station lookup",
});

// Mount OpenAPI discovery so AgentCash can find endpoints
discovery(app, mppx, {
  info: {
    title: "Citi Bike Nearest Station API",
    description:
      "Find the nearest Citi Bike stations with real-time availability including e-bikes, classic bikes, and open docks.",
    version: "1.0.0",
  },
  routes: [
    {
      method: "get",
      path: "/nearest",
      handler: chargeNearest,
      summary:
        "Find nearest Citi Bike stations with e-bike counts, dock availability, and walking time. Query params: lat (required), lng (required), limit (optional, default 3, max 10).",
    },
  ],
});

const STATION_INFO_URL =
  "https://gbfs.lyft.com/gbfs/1.1/bkn/en/station_information.json";
const STATION_STATUS_URL =
  "https://gbfs.lyft.com/gbfs/1.1/bkn/en/station_status.json";

// Cache GBFS data for 60s (it updates ~every 60s anyway)
let cache = { stations: null, status: null, ts: 0 };
const CACHE_TTL = 60_000;

async function fetchGBFS() {
  if (Date.now() - cache.ts < CACHE_TTL && cache.stations) return cache;

  const [infoRes, statusRes] = await Promise.all([
    fetch(STATION_INFO_URL),
    fetch(STATION_STATUS_URL),
  ]);
  const info = await infoRes.json();
  const status = await statusRes.json();

  const statusMap = new Map();
  for (const s of status.data.stations) {
    statusMap.set(s.station_id, s);
  }

  cache = { stations: info.data.stations, statusMap, ts: Date.now() };
  return cache;
}

// Haversine distance in meters
function distance(lat1, lon1, lat2, lon2) {
  const R = 6_371_000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Paid endpoint: $0.01 per request
app.get("/nearest", chargeNearest, async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  const limit = Math.min(parseInt(req.query.limit) || 3, 10);

  if (isNaN(lat) || isNaN(lng)) {
    return res.status(400).json({ error: "lat and lng query params required" });
  }

  try {
    const { stations, statusMap } = await fetchGBFS();

    const results = stations
      .filter((s) => {
        const st = statusMap.get(s.station_id);
        return st && st.is_installed === 1 && st.is_renting === 1;
      })
      .map((s) => {
        const st = statusMap.get(s.station_id);
        const dist = distance(lat, lng, s.lat, s.lon);
        const walk_minutes = Math.round(dist / 80); // ~80m/min avg walking
        return {
          name: s.name,
          distance_meters: Math.round(dist),
          walk_minutes,
          ebikes_available: st.num_ebikes_available,
          bikes_available: st.num_bikes_available,
          docks_available: st.num_docks_available,
          lat: s.lat,
          lng: s.lon,
        };
      })
      .sort((a, b) => a.distance_meters - b.distance_meters)
      .slice(0, limit);

    res.json({ results });
  } catch (err) {
    console.error("GBFS fetch error:", err);
    res.status(502).json({ error: "Failed to fetch station data" });
  }
});

// Free health check
app.get("/", (req, res) => {
  res.json({
    service: "citibike-nearest",
    usage: "GET /nearest?lat=40.73&lng=-73.99&limit=3",
    price: "$0.01 per request (MPP/Tempo USDC)",
  });
});

app.listen(PORT, () => {
  console.log(`Citi Bike API running on http://localhost:${PORT}`);
});
