import express from "express";
import { fileURLToPath } from "url";
import path from "path";
import { Mppx, tempo, discovery } from "mppx/express";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 8080;

// CORS
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Expose-Headers", "WWW-Authenticate");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const USDC_TEMPO = process.env.USDC_TEMPO;
const RECIPIENT = process.env.RECIPIENT;

const mppx = Mppx.create({
  methods: [tempo.charge({ currency: USDC_TEMPO, recipient: RECIPIENT })],
  secretKey: process.env.MPP_SECRET_KEY,
});

// Create payment middleware for both endpoints
const chargeNearest = mppx.charge({
  amount: "0.01",
  description: "Citi Bike nearest station lookup",
});

const chargeDock = mppx.charge({
  amount: "0.01",
  description: "Citi Bike dock availability lookup",
});

// Mount OpenAPI discovery so AgentCash can find endpoints
discovery(app, mppx, {
  info: {
    title: "Citi Bike Nearest Station API",
    description:
      "Pick up a bike or find a dock. Real-time Citi Bike availability for NYC — e-bikes, docks, and walking time.",
    version: "1.0.0",
  },
  serviceInfo: {
    categories: ["transportation", "bikeshare", "nyc", "citibike"],
    docs: {
      homepage: "https://citibike-mpp.vercel.app",
    },
  },
  routes: [
    {
      method: "get",
      path: "/nearest",
      handler: chargeNearest,
      summary:
        "Find nearest Citi Bike stations with e-bike counts, dock availability, and walking time. Use this when you need to pick up a bike. Query params: lat (required), lng (required), limit (optional, default 3, max 10).",
    },
    {
      method: "get",
      path: "/dock",
      handler: chargeDock,
      summary:
        "Find nearest Citi Bike stations with available docks for parking your bike. Use this when you need to drop off a bike. Query params: lat (required), lng (required), limit (optional, default 3, max 10).",
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

function parseLookupQuery(query) {
  const lat = Number.parseFloat(query.lat);
  const lng = Number.parseFloat(query.lng);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { error: "lat and lng query params required" };
  }

  if (query.limit === undefined) {
    return { value: { lat, lng, limit: 3 } };
  }

  const limit = Number.parseInt(query.limit, 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
    return { error: "limit must be an integer between 1 and 10" };
  }

  return { value: { lat, lng, limit } };
}

function validateLookupQuery(req, res, next) {
  const parsed = parseLookupQuery(req.query);
  if (parsed.error) {
    return res.status(400).json({ error: parsed.error });
  }

  req.lookupQuery = parsed.value;
  next();
}

// Paid endpoint: $0.01 per request
app.get("/nearest", validateLookupQuery, chargeNearest, async (req, res) => {
  const { lat, lng, limit } = req.lookupQuery;
  try {
    const { stations, statusMap } = await fetchGBFS();

    const results = stations
      .filter((s) => {
        const st = statusMap.get(s.station_id);
        return (
          st &&
          st.is_installed === 1 &&
          st.is_renting === 1 &&
          (st.num_bikes_available ?? 0) > 0
        );
      })
      .map((s) => {
        const st = statusMap.get(s.station_id);
        const dist = distance(lat, lng, s.lat, s.lon);
        const walk_minutes = Math.round(dist / 80);
        return {
          name: s.name,
          distance_feet: Math.round(dist * 3.281),
          walk_minutes,
          ebikes_available: st.num_ebikes_available ?? 0,
          bikes_available: st.num_bikes_available ?? 0,
          docks_available: st.num_docks_available ?? 0,
          lat: s.lat,
          lng: s.lon,
        };
      })
      .sort((a, b) => a.distance_feet - b.distance_feet)
      .slice(0, limit);

    res.json({ results });
  } catch (err) {
    console.error("GBFS fetch error:", err);
    res.status(502).json({ error: "Failed to fetch station data" });
  }
});

// Paid endpoint: $0.01 per request — find docks to park
app.get("/dock", validateLookupQuery, chargeDock, async (req, res) => {
  const { lat, lng, limit } = req.lookupQuery;
  try {
    const { stations, statusMap } = await fetchGBFS();

    const results = stations
      .filter((s) => {
        const st = statusMap.get(s.station_id);
        return st && st.is_installed === 1 && st.is_returning === 1 && (st.num_docks_available ?? 0) > 0;
      })
      .map((s) => {
        const st = statusMap.get(s.station_id);
        const dist = distance(lat, lng, s.lat, s.lon);
        const walk_minutes = Math.round(dist / 80);
        return {
          name: s.name,
          distance_feet: Math.round(dist * 3.281),
          walk_minutes,
          docks_available: st.num_docks_available ?? 0,
          bikes_available: st.num_bikes_available ?? 0,
          lat: s.lat,
          lng: s.lon,
        };
      })
      .sort((a, b) => a.distance_feet - b.distance_feet)
      .slice(0, limit);

    res.json({ results });
  } catch (err) {
    console.error("GBFS fetch error:", err);
    res.status(502).json({ error: "Failed to fetch station data" });
  }
});

// x402 discovery fallback for crawlers
app.get("/.well-known/x402", (req, res) => {
  res.json({
    version: 1,
    resources: [
      `${req.protocol}://${req.hostname}/nearest`,
      `${req.protocol}://${req.hostname}/dock`,
    ],
  });
});

// llms.txt
app.get("/llms.txt", (req, res) => {
  res.type("text/plain").sendFile(path.join(__dirname, "llms.txt"));
});

// Static assets
app.get("/favicon.svg", (req, res) => {
  res.sendFile(path.join(__dirname, "favicon.svg"));
});

app.get("/og.svg", (req, res) => {
  res.type("image/svg+xml").sendFile(path.join(__dirname, "og.svg"));
});

// Landing page
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.log(`Citi Bike API running on http://localhost:${PORT}`);
});
