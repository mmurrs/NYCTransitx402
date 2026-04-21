/**
 * refresh-examples.mjs — Pre-bake example API responses for the landing page.
 *
 * Calls the same upstream data sources server.js uses (GBFS, GTFS-RT, MTA SIRI),
 * runs the same filtering/formatting logic as the paid API routes, and writes
 * proxy/public/examples.json.
 *
 * Rationale: the landing page widget needs real example responses to animate on,
 * but hitting the paid production API from every visitor would burn MTA quota.
 * Static edge-served JSON is zero-cost, cacheable, and the data shape matches
 * what agents actually get when they pay.
 *
 * Usage:
 *   node --env-file=/path/to/.env.mainnet scripts/refresh-examples.mjs
 *
 * Requires: MTA_BUS_API_KEY env var (for /bus/nearest calls).
 */

import { createRequire } from "module";
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const require = createRequire(import.meta.url);
const GtfsRealtimeBindings = require("gtfs-realtime-bindings");

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..");

const subwayStations = JSON.parse(
  readFileSync(join(REPO, "data/subway-stations.json"), "utf-8")
);

// Manhattan-distance in meters. Matches server.js exactly.
function manhattanDist(lat1, lon1, lat2, lon2) {
  const R = 6_371_000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = R * toRad(Math.abs(lat2 - lat1));
  const dLng =
    R * Math.cos(toRad((lat1 + lat2) / 2)) * toRad(Math.abs(lon2 - lon1));
  return dLat + dLng;
}

// ─── Citi Bike (GBFS) ──────────────────────────────────────────────

const GBFS_INFO = "https://gbfs.lyft.com/gbfs/1.1/bkn/en/station_information.json";
const GBFS_STATUS = "https://gbfs.lyft.com/gbfs/1.1/bkn/en/station_status.json";

let _gbfsCache = null;
async function fetchGBFS() {
  if (_gbfsCache) return _gbfsCache;
  const [infoRes, statusRes] = await Promise.all([
    fetch(GBFS_INFO),
    fetch(GBFS_STATUS),
  ]);
  if (!infoRes.ok || !statusRes.ok) {
    throw new Error(`GBFS fetch failed: info=${infoRes.status} status=${statusRes.status}`);
  }
  const info = await infoRes.json();
  const status = await statusRes.json();
  const statusMap = new Map();
  for (const s of status.data.stations) statusMap.set(s.station_id, s);
  _gbfsCache = { stations: info.data.stations, statusMap };
  return _gbfsCache;
}

async function citibikeNearest(lat, lng, limit = 3) {
  const { stations, statusMap } = await fetchGBFS();
  return stations
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
}

async function citibikeDock(lat, lng, limit = 3) {
  const { stations, statusMap } = await fetchGBFS();
  return stations
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
}

// ─── Subway (GTFS-RT) ──────────────────────────────────────────────

const FEED_URLS = {
  gtfs: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs",
  "gtfs-ace": "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-ace",
  "gtfs-nqrw": "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-nqrw",
  "gtfs-bdfm": "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-bdfm",
  "gtfs-l": "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-l",
  "gtfs-g": "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-g",
  "gtfs-jz": "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-jz",
  "gtfs-si": "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-si",
};

const _feedCache = new Map();
async function fetchFeed(feedId) {
  if (_feedCache.has(feedId)) return _feedCache.get(feedId);
  const res = await fetch(FEED_URLS[feedId]);
  if (!res.ok) throw new Error(`feed ${feedId} HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(buf));
  _feedCache.set(feedId, feed);
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
  return arrivals.sort((a, b) => a.minutes - b.minutes).slice(0, 8);
}

async function subwayNearest(lat, lng, limit = 3) {
  const nearest = subwayStations
    .map((s) => ({ ...s, dist: manhattanDist(lat, lng, s.lat, s.lng) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, limit);
  const feedIds = [...new Set(nearest.flatMap((s) => s.feeds))];
  const feeds = await Promise.all(feedIds.map(fetchFeed));
  const feedMap = new Map(feedIds.map((id, i) => [id, feeds[i]]));
  return nearest.map((s) => {
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
}

// ─── Bus (MTA SIRI) ────────────────────────────────────────────────

// ─── Subway alerts (GTFS-RT Alert feed) ───────────────────────────

const ALERT_FEED_URL =
  "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fsubway-alerts";

function effectEnumToString(effect) {
  if (typeof effect === "string") return effect;
  const map = {
    1: "NO_SERVICE", 2: "REDUCED_SERVICE", 3: "SIGNIFICANT_DELAYS",
    4: "DETOUR", 5: "ADDITIONAL_SERVICE", 6: "MODIFIED_SERVICE",
    7: "OTHER_EFFECT", 8: "UNKNOWN_EFFECT", 9: "STOP_MOVED",
  };
  return map[effect] || "UNKNOWN_EFFECT";
}

function bucketSeverity(effect) {
  switch (effect) {
    case "NO_SERVICE": return "no_service";
    case "REDUCED_SERVICE":
    case "MODIFIED_SERVICE": return "reduced";
    case "SIGNIFICANT_DELAYS": return "delays";
    case "DETOUR": return "detour";
    default: return "info";
  }
}

async function subwayAlerts({ lines = null, limit = 5 } = {}) {
  const res = await fetch(ALERT_FEED_URL);
  if (!res.ok) throw new Error(`alerts feed HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(buf));

  const now = Math.floor(Date.now() / 1000);
  const wantedLines = lines && lines.length > 0 ? new Set(lines) : null;
  const out = [];

  for (const entity of feed.entity || []) {
    const alert = entity.alert;
    if (!alert) continue;

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

    const affectedLines = new Set();
    const stopIds = [];
    for (const ie of alert.informedEntity || []) {
      if (ie.routeId) affectedLines.add(ie.routeId);
      if (ie.stopId) stopIds.push(ie.stopId);
    }
    if (affectedLines.size === 0) continue;
    if (wantedLines) {
      let overlap = false;
      for (const l of affectedLines) if (wantedLines.has(l)) { overlap = true; break; }
      if (!overlap) continue;
    }

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
    const match = description.match(/(\d+\s*[-–]\s*\d+|\d+)\s*(?:min|minute)/i);
    const estimated_minutes = match ? match[1].replace(/\s+/g, "") : null;
    const active_until = currentPeriod?.end
      ? new Date(Number(currentPeriod.end) * 1000).toISOString()
      : null;

    out.push({
      lines: [...affectedLines].sort(),
      effect, severity, direction, header, description,
      estimated_minutes, active_until,
    });
    if (out.length >= limit) break;
  }
  return out;
}

async function busNearest(lat, lng, limit = 3) {
  const key = process.env.MTA_BUS_API_KEY;
  if (!key) throw new Error("MTA_BUS_API_KEY missing");
  const stopsUrl = `https://bustime.mta.info/api/where/stops-for-location.json?lat=${lat}&lon=${lng}&latSpan=0.005&lonSpan=0.005&key=${key}`;
  const stopsRes = await fetch(stopsUrl);
  const stopsData = await stopsRes.json();
  const stops = (stopsData.data?.stops || []).slice(0, limit);
  return Promise.all(
    stops.map(async (stop) => {
      const monUrl = `https://bustime.mta.info/api/siri/stop-monitoring.json?key=${key}&MonitoringRef=${stop.code}&version=2`;
      const monData = await (await fetch(monUrl)).json();
      const visits =
        monData.Siri?.ServiceDelivery?.StopMonitoringDelivery?.[0]?.MonitoredStopVisit || [];
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
    })
  );
}

// ─── Prompt definitions ────────────────────────────────────────────

// Four-prompt escalation: simple → constraint → compositional.
// Maps to the x-guidance pattern: reason over the full result set, present
// top 3 for simple queries, filter by constraints for creative ones.
const prompts = [
  // ── BASE CASE: simple "nearest X" queries ─────────────────────────
  {
    id: "soho-ebike",
    title: "I'm in SoHo — where are the closest e-bikes?",
    subtitle: "5 nearest Citi Bike stations with e-bike counts and walking time",
    kind: "bike",
    origin: { name: "SoHo", lat: 40.7233, lng: -74.0010 },
    calls: [
      { endpoint: "/citibike/nearest", at: "origin", limit: 5 },
    ],
  },
  {
    id: "bedford-l-manhattan",
    title: "Where's the nearest Manhattan-bound L train from Bedford Ave?",
    subtitle: "Live subway arrivals, filtered by direction",
    kind: "subway",
    origin: { name: "Bedford Ave L station", lat: 40.7172, lng: -73.9567 },
    calls: [
      { endpoint: "/subway/nearest", at: "origin", limit: 1 },
    ],
  },

  // ── CREATIVE: constraint filter + multi-modal composition ─────────
  {
    id: "ebike-filter",
    title: "Which Citi Bike stations near Union Sq have 5+ e-bikes right now?",
    subtitle: "Agent fetches the full set, filters by e-bike count before presenting",
    kind: "bike",
    origin: { name: "Union Square", lat: 40.7359, lng: -73.9906 },
    calls: [
      { endpoint: "/citibike/nearest", at: "origin", limit: 10 },
    ],
  },
  {
    id: "subway-alerts-now",
    title: "Any delays or service changes on the subway right now?",
    subtitle: "Active MTA alerts with severity, direction, and estimated delay minutes when present",
    kind: "subway",
    origin: { name: "NYC subway system", lat: 40.7580, lng: -73.9855 },
    calls: [
      { endpoint: "/subway/alerts", at: "origin", limit: 5 },
    ],
  },
  {
    id: "mccarren-ebike-or-l",
    title: "I'm leaving McCarren to West Village — I'll bike home if e-bikes are within 8 min, or I'll take the L",
    subtitle: "Three parallel calls — e-bike availability at origin, open docks at destination, and subway as fallback",
    kind: "multimodal",
    origin: { name: "McCarren Park", lat: 40.7215, lng: -73.9521 },
    destination: { name: "West Village", lat: 40.7345, lng: -74.0050 },
    calls: [
      { endpoint: "/citibike/nearest", at: "origin",      limit: 10 },
      { endpoint: "/citibike/dock",    at: "destination", limit: 5  },
      { endpoint: "/subway/nearest",   at: "origin",      limit: 3  },
    ],
  },
];

// Fetch a real walking route from OSRM public instance (free, no key).
// Returns an array of [lat,lng] points, or null if the route can't be fetched.
// Called at build time per (origin, result) pair, then baked into examples.json.
async function walkingRoute(originLat, originLng, destLat, destLng) {
  const url = `https://router.project-osrm.org/route/v1/foot/${originLng},${originLat};${destLng},${destLat}?geometries=geojson&overview=full`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const data = await res.json();
    const coords = data.routes?.[0]?.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) return null;
    // OSRM returns [lng,lat]; Leaflet wants [lat,lng]
    return coords.map(([ln, lt]) => [lt, ln]);
  } catch {
    return null;
  }
}

async function runCall(call, prompt) {
  const point = call.at === "origin" ? prompt.origin : prompt.destination;
  const { lat, lng } = point;
  const { endpoint, limit = 3, lines = null } = call;
  let results;
  if (endpoint === "/citibike/nearest") results = await citibikeNearest(lat, lng, limit);
  else if (endpoint === "/citibike/dock") results = await citibikeDock(lat, lng, limit);
  else if (endpoint === "/subway/nearest") results = await subwayNearest(lat, lng, limit);
  else if (endpoint === "/subway/alerts") results = await subwayAlerts({ lines, limit });
  else if (endpoint === "/bus/nearest") results = await busNearest(lat, lng, limit);
  else throw new Error(`Unknown endpoint: ${endpoint}`);

  // Attach a pre-computed walking route polyline to each result. Done serially
  // to stay polite with the free OSRM instance (recommended max ~1 req/sec).
  // Alerts don't have per-result coordinates, skip OSRM for them.
  for (const r of results) {
    if (r.lat != null && r.lng != null) {
      const route = await walkingRoute(lat, lng, r.lat, r.lng);
      if (route) r.route = route;
      await new Promise((x) => setTimeout(x, 400));
    }
  }

  return { endpoint, at: call.at, limit, point, response: { results } };
}

async function main() {
  const out = { generatedAt: new Date().toISOString(), prompts: [] };
  for (const prompt of prompts) {
    process.stdout.write(`[refresh] ${prompt.id} ... `);
    const calls = [];
    for (const call of prompt.calls) {
      try {
        calls.push(await runCall(call, prompt));
      } catch (err) {
        console.error(`\n  call ${call.endpoint} at ${call.at} FAILED: ${err.message}`);
        calls.push({ ...call, error: err.message });
      }
    }
    out.prompts.push({ ...prompt, calls });
    console.log("ok");
  }
  const outPath = join(REPO, "proxy/public/examples.json");
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${outPath}`);
  console.log(`  ${out.prompts.length} prompts, generatedAt=${out.generatedAt}`);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
