import express from "express";
import { fileURLToPath } from "url";
import path from "path";
import { createRequire } from "module";
import { Mppx, tempo, discovery } from "mppx/express";

const require = createRequire(import.meta.url);
const GtfsRealtimeBindings = require("gtfs-realtime-bindings");

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

// --- Payment setup ---

const USDC_TEMPO = process.env.USDC_TEMPO;
const RECIPIENT = process.env.RECIPIENT;

const mppx = Mppx.create({
  methods: [tempo.charge({ currency: USDC_TEMPO, recipient: RECIPIENT })],
  secretKey: process.env.MPP_SECRET_KEY,
});

const chargeCitibike = mppx.charge({
  amount: "0.01",
  description: "Citi Bike station lookup",
});

const chargeSubway = mppx.charge({
  amount: "0.01",
  description: "Subway arrival lookup",
});

const chargeBus = mppx.charge({
  amount: "0.01",
  description: "Bus arrival lookup",
});

// --- OpenAPI discovery ---

discovery(app, mppx, {
  info: {
    title: "FindMeA — NYC Transit API",
    description:
      "Real-time NYC transit for agents. Citi Bike stations, subway arrivals, and bus predictions — $0.01 per lookup via MPP.",
    version: "2.0.0",
  },
  serviceInfo: {
    categories: [
      "transportation",
      "transit",
      "nyc",
      "citibike",
      "subway",
      "bus",
    ],
    docs: {
      homepage: "https://citibike-mpp.vercel.app",
    },
  },
  routes: [
    {
      method: "get",
      path: "/citibike/nearest",
      handler: chargeCitibike,
      summary:
        "Find nearest Citi Bike stations with available bikes, e-bike counts, and walking time. Query params: lat (required), lng (required), limit (optional, default 3, max 10).",
    },
    {
      method: "get",
      path: "/citibike/dock",
      handler: chargeCitibike,
      summary:
        "Find nearest Citi Bike stations with available docks for parking. Query params: lat (required), lng (required), limit (optional, default 3, max 10).",
    },
    {
      method: "get",
      path: "/subway/nearest",
      handler: chargeSubway,
      summary:
        "Find nearest subway stations with real-time train arrivals. Returns upcoming trains with ETAs, lines, and direction. Query params: lat (required), lng (required), limit (optional, default 3, max 10).",
    },
    {
      method: "get",
      path: "/bus/nearest",
      handler: chargeBus,
      summary:
        "Find nearest bus stops with real-time arrival predictions. Returns routes, destinations, and ETAs. Query params: lat (required), lng (required), limit (optional, default 3, max 10).",
    },
  ],
});

// --- Shared utilities ---

function haversine(lat1, lon1, lat2, lon2) {
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

// --- Citi Bike (GBFS) ---

const STATION_INFO_URL =
  "https://gbfs.lyft.com/gbfs/1.1/bkn/en/station_information.json";
const STATION_STATUS_URL =
  "https://gbfs.lyft.com/gbfs/1.1/bkn/en/station_status.json";

let gbfsCache = { stations: null, statusMap: null, ts: 0 };
const GBFS_TTL = 60_000;

async function fetchGBFS() {
  if (Date.now() - gbfsCache.ts < GBFS_TTL && gbfsCache.stations)
    return gbfsCache;

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

  gbfsCache = { stations: info.data.stations, statusMap, ts: Date.now() };
  return gbfsCache;
}

app.get(
  "/citibike/nearest",
  validateLookupQuery,
  chargeCitibike,
  async (req, res) => {
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
          const dist = haversine(lat, lng, s.lat, s.lon);
          return {
            name: s.name,
            distance_feet: Math.round(dist * 3.281),
            walk_minutes: Math.round(dist / 80),
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
  },
);

app.get(
  "/citibike/dock",
  validateLookupQuery,
  chargeCitibike,
  async (req, res) => {
    const { lat, lng, limit } = req.lookupQuery;
    try {
      const { stations, statusMap } = await fetchGBFS();

      const results = stations
        .filter((s) => {
          const st = statusMap.get(s.station_id);
          return (
            st &&
            st.is_installed === 1 &&
            st.is_returning === 1 &&
            (st.num_docks_available ?? 0) > 0
          );
        })
        .map((s) => {
          const st = statusMap.get(s.station_id);
          const dist = haversine(lat, lng, s.lat, s.lon);
          return {
            name: s.name,
            distance_feet: Math.round(dist * 3.281),
            walk_minutes: Math.round(dist / 80),
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
  },
);

// --- Subway (GTFS-RT) ---

import { readFileSync } from "fs";

const subwayStations = JSON.parse(
  readFileSync(path.join(__dirname, "data", "subway-stations.json"), "utf-8"),
);

const FEED_URLS = {
  gtfs: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs",
  "gtfs-ace":
    "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-ace",
  "gtfs-nqrw":
    "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-nqrw",
  "gtfs-bdfm":
    "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-bdfm",
  "gtfs-l":
    "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-l",
  "gtfs-g":
    "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-g",
  "gtfs-jz":
    "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-jz",
  "gtfs-si":
    "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-si",
};

// Cache decoded feeds for 30s
const feedCache = new Map();
const FEED_TTL = 30_000;

async function fetchFeed(feedId) {
  const cached = feedCache.get(feedId);
  if (cached && Date.now() - cached.ts < FEED_TTL) return cached.feed;

  const res = await fetch(FEED_URLS[feedId]);
  const buf = await res.arrayBuffer();
  const feed =
    GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(
      new Uint8Array(buf),
    );

  feedCache.set(feedId, { feed, ts: Date.now() });
  return feed;
}

function getArrivalsForStation(feed, stationId) {
  const now = Math.floor(Date.now() / 1000);
  const arrivals = [];

  for (const entity of feed.entity) {
    const tu = entity.tripUpdate;
    if (!tu?.stopTimeUpdate) continue;

    const routeId = tu.trip.routeId;

    for (const stu of tu.stopTimeUpdate) {
      const stopId = stu.stopId;
      // Match child stops (e.g. "101N", "101S") to parent station "101"
      const parentId = stopId.replace(/[NS]$/, "");
      if (parentId !== stationId) continue;

      const arrivalTime = stu.arrival?.time
        ? Number(stu.arrival.time)
        : stu.departure?.time
          ? Number(stu.departure.time)
          : null;

      if (!arrivalTime || arrivalTime < now) continue;

      const direction = stopId.endsWith("N") ? "Uptown" : "Downtown";
      const minutes = Math.round((arrivalTime - now) / 60);

      arrivals.push({ line: routeId, direction, minutes });
    }
  }

  return arrivals
    .sort((a, b) => a.minutes - b.minutes)
    .slice(0, 8);
}

app.get(
  "/subway/nearest",
  validateLookupQuery,
  chargeSubway,
  async (req, res) => {
    const { lat, lng, limit } = req.lookupQuery;
    try {
      // Find nearest stations from static data
      const nearest = subwayStations
        .map((s) => ({
          ...s,
          dist: haversine(lat, lng, s.lat, s.lng),
        }))
        .sort((a, b) => a.dist - b.dist)
        .slice(0, limit);

      // Determine which feeds we need
      const feedIds = [...new Set(nearest.flatMap((s) => s.feeds))];

      // Fetch feeds in parallel
      const feeds = await Promise.all(feedIds.map((id) => fetchFeed(id)));
      const feedMap = new Map(feedIds.map((id, i) => [id, feeds[i]]));

      // Build results with real-time arrivals
      const results = nearest.map((s) => {
        let arrivals = [];
        for (const feedId of s.feeds) {
          const feed = feedMap.get(feedId);
          if (feed) arrivals.push(...getArrivalsForStation(feed, s.stop_id));
        }
        arrivals.sort((a, b) => a.minutes - b.minutes);
        arrivals = arrivals.slice(0, 8);

        return {
          name: s.name,
          distance_feet: Math.round(s.dist * 3.281),
          walk_minutes: Math.round(s.dist / 80),
          lines: s.lines,
          arrivals,
          lat: s.lat,
          lng: s.lng,
        };
      });

      res.json({ results });
    } catch (err) {
      console.error("Subway fetch error:", err);
      res.status(502).json({ error: "Failed to fetch subway data" });
    }
  },
);

// --- Bus (SIRI — requires MTA API key) ---

const BUS_API_KEY = process.env.MTA_BUS_API_KEY;

app.get(
  "/bus/nearest",
  validateLookupQuery,
  (req, res, next) => {
    if (!BUS_API_KEY) {
      return res.status(503).json({
        error: "Bus data coming soon",
        message: "Bus arrival predictions are under development.",
      });
    }
    next();
  },
  chargeBus,
  async (req, res) => {

    const { lat, lng, limit } = req.lookupQuery;
    try {
      // Find nearby stops via OneBusAway
      const stopsUrl = `https://bustime.mta.info/api/where/stops-for-location.json?lat=${lat}&lon=${lng}&latSpan=0.005&lonSpan=0.005&key=${BUS_API_KEY}`;
      const stopsRes = await fetch(stopsUrl);
      const stopsData = await stopsRes.json();
      const stops = (stopsData.data?.stops || []).slice(0, limit);

      // Get real-time predictions for each stop
      const results = await Promise.all(
        stops.map(async (stop) => {
          const monUrl = `https://bustime.mta.info/api/siri/stop-monitoring.json?key=${BUS_API_KEY}&MonitoringRef=${stop.code}&version=2`;
          const monRes = await fetch(monUrl);
          const monData = await monRes.json();

          const visits =
            monData.Siri?.ServiceDelivery?.StopMonitoringDelivery?.[0]
              ?.MonitoredStopVisit || [];

          const now = Date.now();
          const arrivals = visits.slice(0, 6).map((v) => {
            const journey = v.MonitoredVehicleJourney;
            const call = journey?.MonitoredCall;
            const eta = call?.ExpectedArrivalTime
              ? Math.max(0, Math.round((new Date(call.ExpectedArrivalTime) - now) / 60_000))
              : null;
            return {
              route: journey?.PublishedLineName?.[0] || "?",
              destination: journey?.DestinationName?.[0] || "",
              minutes: eta,
              proximity: call?.ArrivalProximityText || null,
              stops_away: call?.NumberOfStopsAway ?? null,
            };
          });

          const dist = haversine(lat, lng, stop.lat, stop.lon);
          return {
            name: stop.name,
            distance_feet: Math.round(dist * 3.281),
            walk_minutes: Math.round(dist / 80),
            routes: stop.routes?.map((r) => r.shortName) || [],
            arrivals,
            lat: stop.lat,
            lng: stop.lon,
          };
        }),
      );

      res.json({ results });
    } catch (err) {
      console.error("Bus fetch error:", err);
      res.status(502).json({ error: "Failed to fetch bus data" });
    }
  },
);

// --- Static routes ---

app.get("/.well-known/x402", (req, res) => {
  const base = `${req.protocol}://${req.hostname}`;
  res.json({
    version: 1,
    resources: [
      `${base}/citibike/nearest`,
      `${base}/citibike/dock`,
      `${base}/subway/nearest`,
      `${base}/bus/nearest`,
    ],
  });
});

app.get("/llms.txt", (req, res) => {
  res.type("text/plain").sendFile(path.join(__dirname, "llms.txt"));
});

app.get("/favicon.svg", (req, res) => {
  res.sendFile(path.join(__dirname, "favicon.svg"));
});

app.get("/og.svg", (req, res) => {
  res.type("image/svg+xml").sendFile(path.join(__dirname, "og.svg"));
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.log(`FindMeA NYC Transit API running on http://localhost:${PORT}`);
});
