import express from "express";
import { fileURLToPath } from "url";
import path from "path";
import { createRequire } from "module";
import { createDual402, dualDiscovery } from "./dual402.js";

const require = createRequire(import.meta.url);
const GtfsRealtimeBindings = require("gtfs-realtime-bindings");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 8080;

// Trust proxy headers (X-Forwarded-Proto, X-Forwarded-Host) behind ecloud/load balancers
app.set("trust proxy", true);
app.use(express.json({ limit: "16kb" }));

// CORS — expose both MPP and x402 payment headers
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader(
    "Access-Control-Expose-Headers",
    "WWW-Authenticate, Payment-Receipt, PAYMENT-REQUIRED, PAYMENT-RESPONSE"
  );
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// --- Payment setup (dual x402 + MPP) ---

const RECIPIENT_WALLET = process.env.RECIPIENT_WALLET;

let dual;
try {
  dual = createDual402({
    mpp: {
      currency: process.env.USDC_TEMPO,
      recipient: process.env.MPP_RECIPIENT || RECIPIENT_WALLET || process.env.RECIPIENT,
      secretKey: process.env.MPP_SECRET_KEY,
      testnet: process.env.MPP_TESTNET === "true",
    },
    x402: {
      payTo: process.env.X402_PAYEE_ADDRESS || RECIPIENT_WALLET,
      network: process.env.X402_NETWORK || "eip155:8453",
      facilitatorUrl:
        process.env.X402_FACILITATOR_URL || "https://x402.org/facilitator",
      // CDP auth is required for Coinbase's hosted facilitator on Base
      // mainnet. Leave both env vars unset to keep unauthenticated calls
      // (e.g. against x402.org/facilitator on Sepolia).
      cdpAuth:
        process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET
          ? {
              apiKeyId: process.env.CDP_API_KEY_ID,
              apiKeySecret: process.env.CDP_API_KEY_SECRET,
            }
          : undefined,
    },
  });
} catch (err) {
  console.error(`[BOOT] FATAL: ${err.message}`);
  process.exit(1);
}

const chargeCitibikeNearest = dual.charge({
  amount: "0.02",
  description: "Nearby Citi Bike pickup stations with available bikes and e-bikes",
});

const chargeCitibikeDock = dual.charge({
  amount: "0.02",
  description: "Nearby Citi Bike return docks with open parking slots",
});

const chargeSubway = dual.charge({
  amount: "0.02",
  description: "Nearby subway stations with real-time train arrivals",
});

const chargeSubwayAlerts = dual.charge({
  amount: "0.02",
  description: "Active subway service alerts with direction, severity, and estimated delay minutes",
});

const chargeBus = dual.charge({
  amount: "0.02",
  description: "Nearby bus stops with real-time arrival predictions",
});

// --- Discovery (mounts /openapi.json + /.well-known/x402) ---

const lookupRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["lat", "lng"],
  properties: {
    lat: {
      type: "number",
      description: "Latitude in WGS84 decimal degrees.",
    },
    lng: {
      type: "number",
      description: "Longitude in WGS84 decimal degrees.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 10,
      default: 5,
      description:
        "Optional number of nearby results to return (1–10, defaults to 5). Fetch the full set to filter by user constraints (min bikes, max walk time, e-bikes only, specific lines/routes), then present the top 3 to the user.",
    },
  },
};

const alertsRequestSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    lines: {
      type: "array",
      items: { type: "string" },
      maxItems: 26,
      description:
        "Optional list of subway line letters/numbers to filter by (e.g. [\"L\", \"G\"]). Omit or pass an empty array to get all currently active alerts. GET clients may pass a comma-separated string.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 50,
      default: 20,
      description: "Optional maximum number of alerts to return (1–50, default 20).",
    },
  },
};

function listResponseSchema(itemSchema) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["results"],
    properties: {
      results: {
        type: "array",
        items: itemSchema,
      },
    },
  };
}

const citibikeNearestItemSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "name",
    "distance_feet",
    "walk_minutes",
    "ebikes_available",
    "bikes_available",
    "docks_available",
    "lat",
    "lng",
  ],
  properties: {
    name: { type: "string" },
    distance_feet: { type: "integer", minimum: 0 },
    walk_minutes: { type: "integer", minimum: 0 },
    ebikes_available: { type: "integer", minimum: 0 },
    bikes_available: { type: "integer", minimum: 0 },
    docks_available: { type: "integer", minimum: 0 },
    lat: { type: "number" },
    lng: { type: "number" },
  },
};

const citibikeDockItemSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "name",
    "distance_feet",
    "walk_minutes",
    "docks_available",
    "bikes_available",
    "lat",
    "lng",
  ],
  properties: {
    name: { type: "string" },
    distance_feet: { type: "integer", minimum: 0 },
    walk_minutes: { type: "integer", minimum: 0 },
    docks_available: { type: "integer", minimum: 0 },
    bikes_available: { type: "integer", minimum: 0 },
    lat: { type: "number" },
    lng: { type: "number" },
  },
};

const subwayNearestItemSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "distance_feet", "walk_minutes", "lines", "arrivals", "lat", "lng"],
  properties: {
    name: { type: "string" },
    distance_feet: { type: "integer", minimum: 0 },
    walk_minutes: { type: "integer", minimum: 0 },
    lines: {
      type: "array",
      items: { type: "string" },
    },
    arrivals: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["line", "direction", "minutes"],
        properties: {
          line: { type: "string" },
          direction: { type: "string", enum: ["Uptown", "Downtown"] },
          minutes: { type: "integer", minimum: 0 },
        },
      },
    },
    lat: { type: "number" },
    lng: { type: "number" },
  },
};

const subwayAlertItemSchema = {
  type: "object",
  additionalProperties: false,
  required: ["lines", "effect", "severity", "direction", "header", "description"],
  properties: {
    lines: {
      type: "array",
      items: { type: "string" },
      description: "Subway lines affected by this alert.",
    },
    effect: {
      type: "string",
      description:
        "Raw GTFS-RT Alert.Effect enum: NO_SERVICE, REDUCED_SERVICE, SIGNIFICANT_DELAYS, DETOUR, ADDITIONAL_SERVICE, MODIFIED_SERVICE, OTHER_EFFECT, UNKNOWN_EFFECT, STOP_MOVED.",
    },
    severity: {
      type: "string",
      enum: ["no_service", "reduced", "delays", "detour", "info"],
      description:
        "Simplified severity bucket normalized from effect. Prefer severity over effect for agent decisioning.",
    },
    direction: {
      type: "string",
      enum: ["both", "Uptown", "Downtown"],
      description:
        "Which direction is affected. 'both' for route-level alerts or alerts affecting both directions of a stop.",
    },
    header: {
      type: "string",
      description: "Short summary text from the alert header.",
    },
    description: {
      type: "string",
      description:
        "Full human-readable description. Often contains specific delay minutes when the MTA provides them.",
    },
    estimated_minutes: {
      type: ["string", "null"],
      description:
        "Delay in minutes extracted from description text when present (e.g. '10-15'). Null when no structured minute estimate is in the alert text.",
    },
    active_until: {
      type: ["string", "null"],
      description:
        "ISO 8601 timestamp when the currently-active period ends, or null if open-ended.",
    },
  },
};

const busNearestItemSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "distance_feet", "walk_minutes", "routes", "arrivals", "lat", "lng"],
  properties: {
    name: { type: "string" },
    distance_feet: { type: "integer", minimum: 0 },
    walk_minutes: { type: "integer", minimum: 0 },
    routes: {
      type: "array",
      items: { type: "string" },
    },
    arrivals: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["route", "destination", "minutes", "proximity", "stops_away"],
        properties: {
          route: { type: "string" },
          destination: { type: "string" },
          minutes: { type: ["integer", "null"], minimum: 0 },
          proximity: { type: ["string", "null"] },
          stops_away: { type: ["integer", "null"], minimum: 0 },
        },
      },
    },
    lat: { type: "number" },
    lng: { type: "number" },
  },
};

const discoveryRoutes = [
  {
    method: "post",
    path: "/citibike/nearest",
    handler: chargeCitibikeNearest,
    operationId: "citibikeNearest",
    tags: ["Citi Bike"],
    summary: "Find nearby Citi Bike stations with available bikes and e-bikes.",
    description:
      "Canonical agent invocation uses POST with JSON body { lat, lng, limit? }. GET with query parameters remains supported for browser/manual use.",
    requestBodySchema: lookupRequestSchema,
    responseSchema: listResponseSchema(citibikeNearestItemSchema),
  },
  {
    method: "post",
    path: "/citibike/dock",
    handler: chargeCitibikeDock,
    operationId: "citibikeDock",
    tags: ["Citi Bike"],
    summary: "Find nearby Citi Bike stations with open docks for returns.",
    description:
      "Canonical agent invocation uses POST with JSON body { lat, lng, limit? }. GET with query parameters remains supported for browser/manual use.",
    requestBodySchema: lookupRequestSchema,
    responseSchema: listResponseSchema(citibikeDockItemSchema),
  },
  {
    method: "post",
    path: "/subway/nearest",
    handler: chargeSubway,
    operationId: "subwayNearest",
    tags: ["Subway"],
    summary: "Find nearby subway stations with live train arrivals.",
    description:
      "Canonical agent invocation uses POST with JSON body { lat, lng, limit? }. GET with query parameters remains supported for browser/manual use.",
    requestBodySchema: lookupRequestSchema,
    responseSchema: listResponseSchema(subwayNearestItemSchema),
  },
  {
    method: "post",
    path: "/subway/alerts",
    handler: chargeSubwayAlerts,
    operationId: "subwayAlerts",
    tags: ["Subway"],
    summary: "Get active subway service alerts, optionally filtered by line.",
    description:
      "Returns active MTA subway alerts with a normalized severity bucket, direction (Uptown / Downtown / both), and estimated delay minutes when the MTA includes them in the description text. Canonical invocation uses POST with JSON body { lines?: string[], limit? }. Omit lines (or pass an empty array) for all active alerts. GET clients may pass lines as a comma-separated string: GET /subway/alerts?lines=L,G.",
    requestBodySchema: alertsRequestSchema,
    responseSchema: listResponseSchema(subwayAlertItemSchema),
  },
  {
    method: "post",
    path: "/bus/nearest",
    handler: chargeBus,
    operationId: "busNearest",
    tags: ["Bus"],
    summary: "Find nearby bus stops with live ETA predictions.",
    description:
      "Canonical agent invocation uses POST with JSON body { lat, lng, limit? }. GET with query parameters remains supported for browser/manual use.",
    requestBodySchema: lookupRequestSchema,
    responseSchema: listResponseSchema(busNearestItemSchema),
  },
];

chargeCitibikeNearest._dualInputSchema = lookupRequestSchema;
chargeCitibikeNearest._dualOutputSchema = listResponseSchema(citibikeNearestItemSchema);
chargeCitibikeDock._dualInputSchema = lookupRequestSchema;
chargeCitibikeDock._dualOutputSchema = listResponseSchema(citibikeDockItemSchema);
chargeSubway._dualInputSchema = lookupRequestSchema;
chargeSubway._dualOutputSchema = listResponseSchema(subwayNearestItemSchema);
chargeSubwayAlerts._dualInputSchema = alertsRequestSchema;
chargeSubwayAlerts._dualOutputSchema = listResponseSchema(subwayAlertItemSchema);
chargeBus._dualInputSchema = lookupRequestSchema;
chargeBus._dualOutputSchema = listResponseSchema(busNearestItemSchema);

dualDiscovery(app, dual, {
  info: {
    title: "NYC Transit Live",
    description:
      "Real-time NYC transit data for agents. Canonical discovery exposes POST JSON operations for subway arrivals, bus ETAs, and Citi Bike pickup/return availability near a coordinate; browser-friendly GET aliases remain supported. Each paid check costs $0.02 via x402 or MPP.",
    version: "2.2.1",
    "x-guidance":
      "Use this API when the user needs real-time NYC subway, bus, or Citi Bike availability near a known coordinate. Resolve place names to latitude/longitude before calling; the API does not geocode.\n\n" +
      "Canonical agent invocation uses POST with JSON body { lat, lng, limit? }. limit defaults to 5 and must be an integer between 1 and 10. Reason over the full result set to answer constraint queries (e.g. stations with ≥3 e-bikes, stops within 8 walking minutes, specific subway lines, return docks with ≥5 open slots), then present the top 3 results to the user unless they ask for more. Equivalent GET query routes remain available for browser and manual use, but OpenAPI POST operations are the preferred discovery target.\n\n" +
      "Choose /subway/nearest for live train arrivals, /bus/nearest for live bus ETAs, /citibike/nearest for bike pickup availability, and /citibike/dock for return docks. For trip-planning questions, call origin and destination endpoints in parallel and compare walking time, arrival minutes, and bike or dock counts. Example: compare /subway/nearest and /citibike/nearest near the trip origin, then /subway/nearest and /citibike/dock near the destination.",
  },
  serviceInfo: {
    categories: [
      "transportation",
      "transit",
      "nyc",
      "new-york-city",
      "citibike",
      "bike-share",
      "subway",
      "bus",
      "mta",
      "real-time",
      "train-arrivals",
      "bus-arrivals",
      "public-transportation",
      "commute",
      "directions",
      "trip-planning",
      "navigation",
      "manhattan",
      "brooklyn",
      "queens",
      "bronx",
      "staten-island",
    ],
    keywords: [
      "NYC",
      "New York City",
      "New York",
      "subway",
      "MTA",
      "bus",
      "MTA bus",
      "Citi Bike",
      "Citibike",
      "bike share",
      "e-bike",
      "ebike",
      "real-time",
      "live",
      "transit",
      "train arrivals",
      "bus arrivals",
      "next train",
      "next bus",
      "public transportation",
      "public transit",
      "mass transit",
      "commute",
      "directions",
      "how do I get",
      "fastest way",
      "quickest route",
      "best way",
      "cheapest way",
      "nearest station",
      "closest",
      "near me",
      "walking distance",
      "from A to B",
      "L train",
      "1 train",
      "6 train",
      "7 train",
      "A train",
      "G train",
      "J train",
      "N train",
      "Q train",
      "R train",
      "M train",
      "F train",
      "the L",
      "the 1",
      "the 6",
      "the A",
      "the 7",
      "the G",
      "Canarsie line",
      "Flushing line",
      "Lex Ave line",
      "Broadway line",
      "Queens Boulevard line",
      "express bus",
      "SBS",
      "Select Bus Service",
      "M15",
      "M60",
      "M86",
      "M104",
      "B44",
      "B46",
      "Bx1",
      "Bx12",
      "Q58",
      "Q70",
      "S53",
      "Staten Island Railway",
      "SIR",
      "Manhattan",
      "Brooklyn",
      "Queens",
      "Bronx",
      "Staten Island",
      "Williamsburg",
      "Greenpoint",
      "Bushwick",
      "Bed-Stuy",
      "Park Slope",
      "DUMBO",
      "Downtown Brooklyn",
      "Astoria",
      "Long Island City",
      "LIC",
      "Jackson Heights",
      "Forest Hills",
      "Flushing",
      "Fordham",
      "Riverdale",
      "SoHo",
      "Tribeca",
      "Chinatown",
      "Flatiron",
      "Chelsea",
      "Hell's Kitchen",
      "Midtown",
      "Lower East Side",
      "East Village",
      "West Village",
      "FiDi",
      "Financial District",
      "Upper East Side",
      "Upper West Side",
      "Harlem",
      "Washington Heights",
      "Hudson Yards",
      "Times Square",
      "Central Park",
      "Penn Station",
      "Grand Central",
      "Port Authority",
      "JFK",
      "LaGuardia",
      "LGA",
      "Newark",
      "EWR",
      "Barclays Center",
      "MSG",
      "Madison Square Garden",
      "Yankee Stadium",
      "Citi Field",
      "Rockefeller Center",
      "Empire State Building",
      "World Trade Center",
      "WTC",
      "Lincoln Center",
      "Prospect Park",
      "Tompkins Square",
      "Washington Square",
      "the High Line",
      "Brooklyn Bridge",
      "Williamsburg Bridge",
      "Javits Center",
      "GTFS-RT",
      "SIRI",
      "GBFS",
    ],
    docs: {
      homepage: "https://transit402.dev",
      llmsTxt: "/llms.txt",
      skill: "/skill.md",
      openapi: "/openapi.json",
    },
  },
  routes: discoveryRoutes,
});

// --- Shared utilities ---

function manhattanDist(lat1, lon1, lat2, lon2) {
  const R = 6_371_000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = R * toRad(Math.abs(lat2 - lat1));
  const dLng =
    R * Math.cos(toRad((lat1 + lat2) / 2)) * toRad(Math.abs(lon2 - lon1));
  return dLat + dLng;
}

function parseLookupInput(input) {
  const source = input && typeof input === "object" ? input : {};
  const lat = Number(source.lat);
  const lng = Number(source.lng);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { error: "lat and lng are required numeric fields" };
  }

  if (source.limit === undefined || source.limit === null || source.limit === "") {
    return { value: { lat, lng, limit: 5 } };
  }

  const limit = Number(source.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
    return { error: "limit must be an integer between 1 and 10" };
  }

  return { value: { lat, lng, limit } };
}

function hasPaymentCredential(req) {
  return Boolean(
    req.headers["payment-signature"] ||
      req.headers["x-payment"] ||
      req.headers["authorization"]?.startsWith("Payment "),
  );
}

function validateLookupInput(getInput, { allowUnpaidInvalid = false } = {}) {
  return (req, res, next) => {
    const parsed = parseLookupInput(getInput(req));
    if (parsed.error) {
      if (allowUnpaidInvalid && !hasPaymentCredential(req)) {
        return next();
      }
      return res.status(400).json({ error: parsed.error });
    }
    req.lookupInput = parsed.value;
    next();
  };
}

const validateLookupQuery = validateLookupInput((req) => req.query);
const validateLookupBody = validateLookupInput((req) => req.body, {
  allowUnpaidInvalid: true,
});

function parseAlertsInput(input) {
  const source = input && typeof input === "object" ? input : {};

  let lines = null;
  if (source.lines !== undefined && source.lines !== null && source.lines !== "") {
    if (Array.isArray(source.lines)) {
      lines = source.lines.map((s) => String(s).trim()).filter(Boolean);
    } else if (typeof source.lines === "string") {
      lines = source.lines.split(",").map((s) => s.trim()).filter(Boolean);
    } else {
      return { error: "lines must be an array of strings or a comma-separated string" };
    }
    if (lines.length === 0) lines = null;
  }

  let limit = 20;
  if (source.limit !== undefined && source.limit !== null && source.limit !== "") {
    limit = Number(source.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      return { error: "limit must be an integer between 1 and 50" };
    }
  }

  return { value: { lines, limit } };
}

function validateAlertsInput(getInput, { allowUnpaidInvalid = false } = {}) {
  return (req, res, next) => {
    const parsed = parseAlertsInput(getInput(req));
    if (parsed.error) {
      if (allowUnpaidInvalid && !hasPaymentCredential(req)) return next();
      return res.status(400).json({ error: parsed.error });
    }
    req.alertsInput = parsed.value;
    next();
  };
}

const validateAlertsQuery = validateAlertsInput((req) => req.query);
const validateAlertsBody = validateAlertsInput((req) => req.body, {
  allowUnpaidInvalid: true,
});

function paymentProtocol(req) {
  if (req.headers["payment-signature"] || req.headers["x-payment"]) return "x402";
  if (req.headers["authorization"]?.startsWith("Payment ")) return "mpp";
  return "unknown";
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

  const t0 = Date.now();
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
  console.log(`[GBFS] refresh stations=${info.data.stations.length} fetch_ms=${Date.now() - t0}`);
  return gbfsCache;
}

async function handleCitibikeNearest(req, res) {
  const { lat, lng, limit } = req.lookupInput;
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
        const dist = manhattanDist(lat, lng, s.lat, s.lon);
        return {
          name: s.name,
          distance_feet: Math.round(dist * 3.281),
          walk_minutes: Math.round(dist / 67),
          ebikes_available: st.num_ebikes_available ?? 0,
          bikes_available: st.num_bikes_available ?? 0,
          docks_available: st.num_docks_available ?? 0,
          lat: s.lat,
          lng: s.lon,
        };
      })
      .sort((a, b) => a.distance_feet - b.distance_feet)
      .slice(0, limit);

    console.log(`[REQ] /citibike/nearest protocol=${paymentProtocol(req)} results=${results.length} cache_age_s=${Math.round((Date.now() - gbfsCache.ts) / 1000)}`);
    res.json({ results });
  } catch (err) {
    console.error("[GBFS] error:", err.message);
    res.status(502).json({ error: "Failed to fetch station data" });
  }
}

async function handleCitibikeDock(req, res) {
  const { lat, lng, limit } = req.lookupInput;
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
        const dist = manhattanDist(lat, lng, s.lat, s.lon);
        return {
          name: s.name,
          distance_feet: Math.round(dist * 3.281),
          walk_minutes: Math.round(dist / 67),
          docks_available: st.num_docks_available ?? 0,
          bikes_available: st.num_bikes_available ?? 0,
          lat: s.lat,
          lng: s.lon,
        };
      })
      .sort((a, b) => a.distance_feet - b.distance_feet)
      .slice(0, limit);

    console.log(`[REQ] /citibike/dock protocol=${paymentProtocol(req)} results=${results.length} cache_age_s=${Math.round((Date.now() - gbfsCache.ts) / 1000)}`);
    res.json({ results });
  } catch (err) {
    console.error("[GBFS] error:", err.message);
    res.status(502).json({ error: "Failed to fetch station data" });
  }
}

app.get("/citibike/nearest", validateLookupQuery, chargeCitibikeNearest, handleCitibikeNearest);
app.post("/citibike/nearest", validateLookupBody, chargeCitibikeNearest, handleCitibikeNearest);

app.get("/citibike/dock", validateLookupQuery, chargeCitibikeDock, handleCitibikeDock);
app.post("/citibike/dock", validateLookupBody, chargeCitibikeDock, handleCitibikeDock);

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
  "subway-alerts":
    "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fsubway-alerts",
};

// Cache decoded feeds for 30s
const feedCache = new Map();
const FEED_TTL = 30_000;

async function fetchFeed(feedId) {
  const cached = feedCache.get(feedId);
  if (cached && Date.now() - cached.ts < FEED_TTL) return cached.feed;

  const t0 = Date.now();
  const res = await fetch(FEED_URLS[feedId]);
  const buf = await res.arrayBuffer();
  const feed =
    GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(
      new Uint8Array(buf),
    );

  feedCache.set(feedId, { feed, ts: Date.now() });
  console.log(`[GTFS] refresh feed=${feedId} entities=${feed.entity.length} fetch_ms=${Date.now() - t0}`);
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

async function handleSubwayNearest(req, res) {
  const { lat, lng, limit } = req.lookupInput;
  try {
    // Find nearest stations from static data
    const nearest = subwayStations
      .map((s) => ({
        ...s,
        dist: manhattanDist(lat, lng, s.lat, s.lng),
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
        walk_minutes: Math.round(s.dist / 67),
        lines: s.lines,
        arrivals,
        lat: s.lat,
        lng: s.lng,
      };
    });

    const maxCacheAge = Math.max(...feedIds.map(id => Date.now() - (feedCache.get(id)?.ts ?? 0)));
    console.log(`[REQ] /subway/nearest protocol=${paymentProtocol(req)} results=${results.length} feeds=${feedIds.length} max_cache_age_s=${Math.round(maxCacheAge / 1000)}`);
    res.json({ results });
  } catch (err) {
    console.error("[GTFS] error:", err.message);
    res.status(502).json({ error: "Failed to fetch subway data" });
  }
}

app.get("/subway/nearest", validateLookupQuery, chargeSubway, handleSubwayNearest);
app.post("/subway/nearest", validateLookupBody, chargeSubway, handleSubwayNearest);

// --- Subway alerts (GTFS-RT Alert entities) ---

// Map GTFS-RT Alert.Effect numeric enum to canonical strings.
// The gtfs-realtime-bindings package sometimes decodes this as an integer and
// sometimes as the string already — normalize both paths.
function effectEnumToString(effect) {
  if (typeof effect === "string") return effect;
  const map = {
    1: "NO_SERVICE",
    2: "REDUCED_SERVICE",
    3: "SIGNIFICANT_DELAYS",
    4: "DETOUR",
    5: "ADDITIONAL_SERVICE",
    6: "MODIFIED_SERVICE",
    7: "OTHER_EFFECT",
    8: "UNKNOWN_EFFECT",
    9: "STOP_MOVED",
  };
  return map[effect] || "UNKNOWN_EFFECT";
}

// Bucket the GTFS-RT effect into a short agent-facing severity string.
function bucketSeverity(effect) {
  switch (effect) {
    case "NO_SERVICE": return "no_service";
    case "REDUCED_SERVICE":
    case "MODIFIED_SERVICE":
      return "reduced";
    case "SIGNIFICANT_DELAYS": return "delays";
    case "DETOUR": return "detour";
    default: return "info";
  }
}

// Parse a GTFS-RT FeedMessage of alerts into our response shape.
// Filters to currently-active alerts and optionally to a set of requested lines.
function parseSubwayAlerts(feed, { lines = null, limit = 20 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const wantedLines = lines && lines.length > 0 ? new Set(lines) : null;

  const results = [];
  for (const entity of feed.entity || []) {
    const alert = entity.alert;
    if (!alert) continue;

    // Active-period filter. If no activePeriod is set, treat as always active.
    const activePeriods = alert.activePeriod || [];
    let currentPeriod = null;
    if (activePeriods.length > 0) {
      currentPeriod = activePeriods.find((p) => {
        const start = p.start ? Number(p.start) : 0;
        const end = p.end ? Number(p.end) : Infinity;
        return now >= start && now <= end;
      });
      if (!currentPeriod) continue;
    }

    // Collect affected lines + stop IDs from informed_entity.
    const affectedLines = new Set();
    const stopIds = [];
    for (const ie of alert.informedEntity || []) {
      if (ie.routeId) affectedLines.add(ie.routeId);
      if (ie.stopId) stopIds.push(ie.stopId);
    }
    if (affectedLines.size === 0) continue;

    // Filter by requested lines (intersection).
    if (wantedLines) {
      let overlap = false;
      for (const l of affectedLines) {
        if (wantedLines.has(l)) { overlap = true; break; }
      }
      if (!overlap) continue;
    }

    // Direction inference from stop_id N/S suffix (same convention as /subway/nearest).
    let direction = "both";
    if (stopIds.length > 0) {
      const hasN = stopIds.some((s) => s.endsWith("N"));
      const hasS = stopIds.some((s) => s.endsWith("S"));
      if (hasN && !hasS) direction = "Uptown";
      else if (hasS && !hasN) direction = "Downtown";
    }

    const header = alert.headerText?.translation?.[0]?.text || "";
    const description = alert.descriptionText?.translation?.[0]?.text || "";

    const effect = effectEnumToString(alert.effect);
    const severity = bucketSeverity(effect);

    // Extract "N", "N-M", or "N–M" minute patterns from description text.
    const match = description.match(/(\d+\s*[-–]\s*\d+|\d+)\s*(?:min|minute)/i);
    const estimated_minutes = match ? match[1].replace(/\s+/g, "") : null;

    const active_until = currentPeriod?.end
      ? new Date(Number(currentPeriod.end) * 1000).toISOString()
      : null;

    results.push({
      lines: [...affectedLines].sort(),
      effect,
      severity,
      direction,
      header,
      description,
      estimated_minutes,
      active_until,
    });

    if (results.length >= limit) break;
  }

  return results;
}

async function handleSubwayAlerts(req, res) {
  const { lines, limit } = req.alertsInput;
  try {
    const feed = await fetchFeed("subway-alerts");
    const results = parseSubwayAlerts(feed, { lines, limit });
    console.log(
      `[REQ] /subway/alerts protocol=${paymentProtocol(req)} results=${results.length} lines=${lines?.join(",") || "all"}`,
    );
    res.json({ results });
  } catch (err) {
    console.error("[ALERTS] error:", err.message);
    res.status(502).json({ error: "Failed to fetch subway alerts" });
  }
}

app.get("/subway/alerts", validateAlertsQuery, chargeSubwayAlerts, handleSubwayAlerts);
app.post("/subway/alerts", validateAlertsBody, chargeSubwayAlerts, handleSubwayAlerts);

// --- Bus (SIRI — requires MTA API key) ---

const BUS_API_KEY = process.env.MTA_BUS_API_KEY;

function requireBusApiKey(req, res, next) {
  if (!BUS_API_KEY) {
    return res.status(503).json({
      error: "Bus predictions unavailable",
      message: "This server is missing MTA_BUS_API_KEY.",
    });
  }
  next();
}

async function handleBusNearest(req, res) {
  const { lat, lng, limit } = req.lookupInput;
  const t0 = Date.now();
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

        const dist = manhattanDist(lat, lng, stop.lat, stop.lon);
        return {
          name: stop.name,
          distance_feet: Math.round(dist * 3.281),
          walk_minutes: Math.round(dist / 67),
          routes: stop.routes?.map((r) => r.shortName) || [],
          arrivals,
          lat: stop.lat,
          lng: stop.lon,
        };
      }),
    );

    const totalArrivals = results.reduce((sum, r) => sum + r.arrivals.length, 0);
    console.log(`[BUS] fetch stops=${results.length} arrivals=${totalArrivals} fetch_ms=${Date.now() - t0}`);
    console.log(`[REQ] /bus/nearest protocol=${paymentProtocol(req)} results=${results.length} arrivals=${totalArrivals}`);
    res.json({ results });
  } catch (err) {
    console.error("[BUS] error:", err.message);
    res.status(502).json({ error: "Failed to fetch bus data" });
  }
}

app.get("/bus/nearest", requireBusApiKey, validateLookupQuery, chargeBus, handleBusNearest);
app.post("/bus/nearest", requireBusApiKey, validateLookupBody, chargeBus, handleBusNearest);

// --- Static routes ---
// Static assets (index.html, viz.html, favicon, og, llms.txt, skill.md) are
// served by Vercel directly from proxy/public/. This server only handles the
// API surface, /openapi.json, and /.well-known/x402 — all of which are mounted
// above. Direct-IP hits (bypassing Vercel) do not resolve static paths.

app.get("/", (req, res) => {
  res.status(200).json({
    service: "NYC Transit Live",
    docs: "https://transit402.dev",
    openapi: "/openapi.json",
    discovery: "/.well-known/x402",
  });
});

app.listen(PORT, () => {
  const facilitatorHost = (() => {
    try {
      return new URL(dual._x402Config.facilitatorUrl).host;
    } catch {
      return "invalid";
    }
  })();
  const cdpAuth = dual._x402Config.cdpAuth ? "configured" : "missing";
  console.log(
    `[BOOT] NYC Transit Live port=${PORT} x402=${dual._x402Config.network} ` +
    `facilitator=${facilitatorHost} cdp_auth=${cdpAuth} ` +
    `mpp=${dual._mppx ? "configured" : "missing"} ` +
    `bus_key=${BUS_API_KEY ? "configured" : "missing"} ` +
    `stations=${subwayStations.length}`
  );
});
