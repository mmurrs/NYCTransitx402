/**
 * Invariant test suite — boots the server once with .env.test, hits real
 * routes, and asserts the invariants listed in INVARIANTS.md.
 *
 * Uses Node's built-in test runner. Zero dependencies.
 *
 * Run:
 *   node --test tests/invariants.test.mjs
 *
 * Expects .env.test in the repo root with testnet values.
 */

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..");
const ENV_FILE = join(REPO, ".env.test");
const PORT = Number(process.env.TEST_PORT || 8088);
const BASE = `http://127.0.0.1:${PORT}`;
// The test server boots with BASE_URL set so D2 can assert the production
// fix (resource URLs derived from BASE_URL, not the Host / origin IP).
const TEST_BASE_URL = "http://test.example";

// Parse .env.test so we can assert expected network / payee from the same
// source the server boots with.
function parseEnv(path) {
  if (!existsSync(path)) return {};
  const env = {};
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return env;
}

const ENV = parseEnv(ENV_FILE);
const LOOKUP = { lat: 40.7128, lng: -74.0060 };

function postJson(path, body) {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function waitForReady(url, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (r.status === 402 || r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`server not ready at ${url} within ${timeoutMs}ms`);
}

function spawnServer({ envOverrides = {} } = {}) {
  return spawn(
    process.execPath,
    ["--env-file", ENV_FILE, join(REPO, "server.js")],
    {
      env: { ...process.env, ...envOverrides, PORT: String(PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
}

// ─────────────────────────────────────────────────────────────────────
// Main suite: boots the server once for all route-level invariants.
// ─────────────────────────────────────────────────────────────────────

describe("invariants (live server)", () => {
  let proc;
  const stderr = [];
  const stdout = [];

  before(async () => {
    assert.ok(
      existsSync(ENV_FILE),
      `.env.test missing at ${ENV_FILE} — copy .env.example and set testnet values`
    );
    proc = spawnServer({ envOverrides: { BASE_URL: TEST_BASE_URL } });
    proc.stdout.on("data", (d) => stdout.push(d.toString()));
    proc.stderr.on("data", (d) => stderr.push(d.toString()));
    // Any unpaid route works — we just need to know the server is up.
    // /openapi.json is unpaid and cheap.
    await waitForReady(`${BASE}/openapi.json`);
  });

  after(() => {
    if (proc && !proc.killed) proc.kill("SIGTERM");
  });

  // ── P1: paid routes never return 200 without a verified payment ──
  test("P1: unauthenticated /citibike/nearest returns 402", async () => {
    const r = await fetch(
      `${BASE}/citibike/nearest?lat=40.7128&lng=-74.0060`
    );
    assert.equal(r.status, 402, "expected 402 without payment");
  });

  // ── P2: 402 carries BOTH protocol headers ──
  test("P2: 402 response carries both PAYMENT-REQUIRED and WWW-Authenticate", async () => {
    const r = await fetch(
      `${BASE}/citibike/nearest?lat=40.7128&lng=-74.0060`
    );
    assert.equal(r.status, 402);
    assert.ok(
      r.headers.get("payment-required"),
      "missing PAYMENT-REQUIRED header (x402 challenge)"
    );
    assert.ok(
      r.headers.get("www-authenticate"),
      "missing WWW-Authenticate header (MPP challenge)"
    );
  });

  // ── P3: PAYMENT-REQUIRED decodes to valid x402 v2 matching config ──
  test("P3: PAYMENT-REQUIRED decodes to x402 v2 with config-matching fields", async () => {
    const r = await fetch(
      `${BASE}/citibike/nearest?lat=40.7128&lng=-74.0060`
    );
    const pr = r.headers.get("payment-required");
    const decoded = JSON.parse(Buffer.from(pr, "base64").toString("utf-8"));
    assert.equal(decoded.x402Version, 2, "x402Version must be 2");
    assert.ok(
      Array.isArray(decoded.accepts) && decoded.accepts.length >= 1,
      "accepts[] must be populated"
    );
    const a = decoded.accepts[0];
    assert.equal(a.scheme, "exact");
    assert.equal(a.network, ENV.X402_NETWORK || "eip155:8453");
    assert.ok(a.asset && a.asset.startsWith("0x"), "asset must be 0x-prefixed");
    const expectedPayee = ENV.X402_PAYEE_ADDRESS || ENV.RECIPIENT_WALLET;
    assert.equal(
      a.payTo?.toLowerCase(),
      expectedPayee?.toLowerCase(),
      "payTo must match env"
    );
    assert.equal(a.amount, "20000", "amount must be 20000 raw (= $0.02 USDC)");
    assert.ok(a.maxTimeoutSeconds > 0, "maxTimeoutSeconds must be positive");
    assert.equal(
      a.resource,
      `${TEST_BASE_URL}/citibike/nearest`,
      "runtime resource must use BASE_URL and strip query strings"
    );
    // Canonical method for this route is POST, so schema exposes `body`
    // (not `queryParams`) per the x402 Bazaar BodyDiscoveryInfo shape.
    assert.ok(
      decoded.extensions?.bazaar?.schema?.properties?.input?.properties?.body,
      "runtime challenge must advertise input body schema hints"
    );
    assert.ok(
      decoded.extensions?.bazaar?.schema?.properties?.output?.properties?.example,
      "runtime challenge must advertise output schema hints"
    );
    // Bazaar validator uses this example to probe the endpoint — must be
    // a real body shape (not `{}`) or the probe fails request validation.
    const infoBody = decoded.extensions?.bazaar?.info?.input?.body;
    assert.ok(
      infoBody && typeof infoBody === "object" && Object.keys(infoBody).length > 0,
      "info.input.body must carry a concrete example for Bazaar probes"
    );
    assert.equal(
      decoded.extensions?.bazaar?.info?.input?.method,
      "POST",
      "info.input.method must be the route's canonical method, not the probing method"
    );
  });

  // ── P4: wrong amount in client-provided sig is rejected locally ──
  test("P4: forged PAYMENT-SIGNATURE with wrong amount is rejected (still 402)", async () => {
    const forged = Buffer.from(
      JSON.stringify({
        amount: "1", // wrong — expected 20000
        payTo: ENV.X402_PAYEE_ADDRESS || ENV.RECIPIENT_WALLET,
      })
    ).toString("base64");
    const r = await fetch(
      `${BASE}/citibike/nearest?lat=40.7128&lng=-74.0060`,
      { headers: { "PAYMENT-SIGNATURE": forged } }
    );
    assert.equal(r.status, 402, "wrong-amount payload must not buy access");
  });

  // ── P5: wrong payee in client-provided sig is rejected locally ──
  test("P5: forged PAYMENT-SIGNATURE with wrong payee is rejected (still 402)", async () => {
    const forged = Buffer.from(
      JSON.stringify({
        amount: "20000",
        payTo: "0x1111111111111111111111111111111111111111",
      })
    ).toString("base64");
    const r = await fetch(
      `${BASE}/citibike/nearest?lat=40.7128&lng=-74.0060`,
      { headers: { "PAYMENT-SIGNATURE": forged } }
    );
    assert.equal(r.status, 402, "wrong-payee payload must not buy access");
  });

  // ── P6: missing amount is rejected (no "absent = wave through") ──
  test("P6: PAYMENT-SIGNATURE missing amount is rejected", async () => {
    const forged = Buffer.from(
      JSON.stringify({ payTo: ENV.X402_PAYEE_ADDRESS || ENV.RECIPIENT_WALLET })
    ).toString("base64");
    const r = await fetch(
      `${BASE}/citibike/nearest?lat=40.7128&lng=-74.0060`,
      { headers: { "PAYMENT-SIGNATURE": forged } }
    );
    assert.equal(r.status, 402, "missing amount must not buy access");
  });

  // ── P7: missing payee is rejected ──
  test("P7: PAYMENT-SIGNATURE missing payTo is rejected", async () => {
    const forged = Buffer.from(
      JSON.stringify({ amount: "20000" })
    ).toString("base64");
    const r = await fetch(
      `${BASE}/citibike/nearest?lat=40.7128&lng=-74.0060`,
      { headers: { "PAYMENT-SIGNATURE": forged } }
    );
    assert.equal(r.status, 402, "missing payTo must not buy access");
  });

  // ── D1: /.well-known/x402 publishes v1 METHOD /path fallback ──
  test("D1: /.well-known/x402 shape", async () => {
    const r = await fetch(`${BASE}/.well-known/x402`);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.deepEqual(j, {
      version: 1,
      resources: [
        "POST /citibike/nearest",
        "POST /citibike/dock",
        "POST /subway/nearest",
        "POST /subway/alerts",
        "POST /bus/nearest",
      ],
    });
  });

  // ── D2: OpenAPI is canonical and exposes POST JSON schemas ──
  test("D2: /openapi.json uses POST operations with request and response schemas", async () => {
    const r = await fetch(`${BASE}/openapi.json`);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.openapi, "3.1.0");
    assert.ok(typeof j.info?.["x-guidance"] === "string" && j.info["x-guidance"].length > 0);
    assert.deepEqual(
      Object.keys(j.paths).sort(),
      ["/bus/nearest", "/citibike/dock", "/citibike/nearest", "/subway/alerts", "/subway/nearest"],
    );
    for (const path of Object.keys(j.paths)) {
      const op = j.paths[path].post;
      assert.ok(op, `missing POST operation for ${path}`);
      assert.ok(!j.paths[path].get, `discovery should prefer canonical POST for ${path}`);
      const input = op.requestBody?.content?.["application/json"]?.schema;
      assert.ok(input, `missing application/json input schema for ${path}`);
      const output = op.responses?.["200"]?.content?.["application/json"]?.schema;
      assert.ok(output, `missing application/json output schema for ${path}`);
    }
    // Lat/lng-required routes share a single body schema with a bounded limit.
    for (const path of ["/bus/nearest", "/citibike/dock", "/citibike/nearest", "/subway/nearest"]) {
      const input = j.paths[path].post.requestBody.content["application/json"].schema;
      assert.ok(
        Array.isArray(input.required) && input.required.includes("lat") && input.required.includes("lng"),
        `input schema for ${path} must require lat/lng`,
      );
      assert.equal(input.properties?.limit?.maximum, 10, `limit maximum must be 10 for ${path}`);
    }
  });

  // ── D3: /openapi.json uses AgentCash payment metadata shape ──
  test("D3: /openapi.json shape — fixed pricing and protocol descriptors", async () => {
    const r = await fetch(`${BASE}/openapi.json`);
    assert.equal(r.status, 200);
    const j = await r.json();
    for (const p of Object.values(j.paths)) {
      const op = p.post;
      assert.ok(op["x-payment-info"], "x-payment-info required");
      const paymentInfo = op["x-payment-info"];
      assert.equal(paymentInfo.price?.mode, "fixed");
      assert.equal(paymentInfo.price?.currency, "USD");
      assert.equal(paymentInfo.price?.amount, "0.02");
      const protos = paymentInfo.protocols;
      assert.ok(Array.isArray(protos) && protos.length >= 2);
      const x402 = protos.find((x) => x.x402)?.x402;
      const mpp = protos.find((x) => x.mpp)?.mpp;
      assert.ok(x402 && typeof x402 === "object", "x402 protocol entry required");
      assert.ok(mpp?.method && mpp.method.length > 0, "mpp.method must not be empty");
      assert.ok(mpp?.intent && mpp.intent.length > 0, "mpp.intent must not be empty");
      assert.ok(mpp?.currency && mpp.currency.length > 0, "mpp.currency must not be empty");
      assert.equal(op.responses?.["402"]?.description, "Payment Required");
    }
  });

  // ── D4: price consistency between openapi and runtime 402 ──
  test("D4: openapi fixed price matches runtime PAYMENT-REQUIRED amount", async () => {
    const [oaR, prR] = await Promise.all([
      fetch(`${BASE}/openapi.json`),
      postJson("/citibike/nearest", LOOKUP),
    ]);
    const oa = await oaR.json();
    assert.equal(prR.status, 402, "unpaid canonical POST should challenge");
    const op = oa.paths["/citibike/nearest"]?.post;
    assert.ok(op, "openapi missing POST /citibike/nearest");
    const usd = op["x-payment-info"].price.amount;
    const rawFromUsd = Math.round(parseFloat(usd) * 1e6).toString();
    const decoded = JSON.parse(
      Buffer.from(prR.headers.get("payment-required"), "base64").toString("utf-8")
    );
    assert.equal(
      decoded.accepts?.[0]?.amount,
      rawFromUsd,
      `price mismatch for /citibike/nearest: openapi=${usd} (${rawFromUsd} raw), runtime=${decoded.accepts?.[0]?.amount}`
    );
  });

  // ── D5: discovery probes can hit canonical POST without a body and still get 402 ──
  test("D5: empty canonical POST returns 402 for unpaid discovery probes", async () => {
    const r = await fetch(`${BASE}/citibike/nearest`, { method: "POST" });
    assert.equal(r.status, 402, "empty unpaid POST should return 402, not 400");
    assert.ok(r.headers.get("payment-required"), "probe-friendly POST must advertise PAYMENT-REQUIRED");
  });

  // ── D6: runtime challenge descriptions are route-specific and informative ──
  test("D6: runtime resource descriptions distinguish endpoints", async () => {
    const cases = [
      [
        "/citibike/nearest?lat=40.7128&lng=-74.0060",
        "Nearby Citi Bike pickup stations with available bikes and e-bikes",
      ],
      [
        "/citibike/dock?lat=40.7128&lng=-74.0060",
        "Nearby Citi Bike return docks with open parking slots",
      ],
      [
        "/subway/nearest?lat=40.7128&lng=-74.0060",
        "Nearby subway stations with real-time train arrivals",
      ],
    ];

    if (ENV.MTA_BUS_API_KEY) {
      cases.push([
        "/bus/nearest?lat=40.7128&lng=-74.0060",
        "Nearby bus stops with real-time arrival predictions",
      ]);
    }

    for (const [path, expectedDescription] of cases) {
      const r = await fetch(`${BASE}${path}`);
      assert.equal(r.status, 402, `${path} must return 402 when unpaid`);
      const decoded = JSON.parse(
        Buffer.from(r.headers.get("payment-required"), "base64").toString("utf-8")
      );
      assert.equal(
        decoded.resource?.description,
        expectedDescription,
        `runtime description mismatch for ${path}`,
      );
    }
  });

  // ── O2: CORS exposes payment headers ──
  test("O2: CORS exposes PAYMENT-REQUIRED and WWW-Authenticate", async () => {
    const r = await fetch(
      `${BASE}/citibike/nearest?lat=40.7128&lng=-74.0060`
    );
    const expose = r.headers.get("access-control-expose-headers") || "";
    assert.ok(
      /PAYMENT-REQUIRED/i.test(expose),
      "PAYMENT-REQUIRED must be exposed via CORS"
    );
    assert.ok(
      /WWW-Authenticate/i.test(expose),
      "WWW-Authenticate must be exposed via CORS"
    );
  });

  // ── C1: unpaid invalid coordinates still see a 402 (discovery probes
  // without params or with bad params must reach the payment layer so
  // x402/Bazaar validators can index the endpoint). Paid-and-invalid
  // returns 400 — see C1b.
  test("C1: unpaid invalid lat/lng returns 402 (discovery-friendly)", async () => {
    const r = await fetch(`${BASE}/citibike/nearest?lat=nope&lng=${LOOKUP.lng}`);
    assert.equal(r.status, 402, "unpaid invalid coords must return 402");
  });

  test("C1b: paid invalid lat/lng returns 400", async () => {
    const forged = Buffer.from(
      JSON.stringify({ amount: "20000", payTo: ENV.X402_PAYEE_ADDRESS || ENV.RECIPIENT_WALLET }),
    ).toString("base64");
    const r = await fetch(`${BASE}/citibike/nearest?lat=nope&lng=${LOOKUP.lng}`, {
      headers: { "PAYMENT-SIGNATURE": forged },
    });
    assert.equal(r.status, 400, "paid invalid coords must return 400");
  });

  // ── C2: unpaid out-of-range limit still 402 (same rationale as C1) ──
  test("C2: unpaid out-of-range limit returns 402", async () => {
    const r = await fetch(`${BASE}/citibike/nearest?lat=${LOOKUP.lat}&lng=${LOOKUP.lng}&limit=11`);
    assert.equal(r.status, 402, "unpaid out-of-range limit must return 402");
  });

  // ── C3: /bus/nearest returns 503 when MTA_BUS_API_KEY is absent ──
  // (Only meaningful if .env.test does NOT set MTA_BUS_API_KEY.)
  test("C3: /bus/nearest returns 503 when MTA_BUS_API_KEY is absent", async (t) => {
    if (ENV.MTA_BUS_API_KEY) {
      t.skip("MTA_BUS_API_KEY is set in .env.test; C3 not applicable");
      return;
    }
    const r = await fetch(`${BASE}/bus/nearest?lat=40.7128&lng=-74.0060`);
    assert.equal(r.status, 503, "must be 503 (not 500/502) without bus key");
  });
});

// ─────────────────────────────────────────────────────────────────────
// Boot-time invariant: missing env must fail fast with a clean message.
// Runs a fresh process, does NOT need the main server.
// ─────────────────────────────────────────────────────────────────────

describe("invariants (boot-time)", () => {
  test("P9: server exits with [BOOT] FATAL when MPP_SECRET_KEY is missing", async () => {
    // Override MPP_SECRET_KEY to empty; keep everything else from .env.test
    const proc = spawn(
      process.execPath,
      ["--env-file", ENV_FILE, join(REPO, "server.js")],
      {
        env: { ...process.env, MPP_SECRET_KEY: "", PORT: String(PORT + 1) },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    let stderr = "";
    let stdout = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    const code = await new Promise((resolve) => {
      proc.on("exit", resolve);
      setTimeout(() => {
        if (!proc.killed) proc.kill("SIGKILL");
        resolve(-1);
      }, 4000);
    });
    const all = stderr + stdout;
    assert.notEqual(code, 0, `server must exit non-zero, got ${code}`);
    assert.match(all, /\[BOOT\] FATAL/, "must log [BOOT] FATAL prefix");
    assert.match(
      all,
      /MPP_SECRET_KEY/,
      "must identify which env var is missing"
    );
  });
});
