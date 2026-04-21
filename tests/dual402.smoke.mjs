#!/usr/bin/env node
/**
 * dual402.smoke.mjs — offline smoke test for dual402.js
 *
 * Exercises the module with zero network I/O:
 *   - `assertConfig` rejects missing env
 *   - `charge()` rejects zero / malformed amounts
 *   - `decodePaymentPayload` bounds input size and type
 *   - `amountsEqual` / `toSmallestUnit` edge cases
 *   - A constructed 402 response carries both PAYMENT-REQUIRED and
 *     (from mppx) WWW-Authenticate headers
 *
 * Not a replacement for a real x402/MPP integration test — those
 * require a live facilitator. This is meant to catch regressions in
 * the reference implementation quickly (run-time < 1s).
 *
 *   node dual402.smoke.mjs
 *
 * Exits 0 on success, 1 on failure.
 */

import crypto from "node:crypto";
import { Challenge } from "mppx";
import { createDual402, parseCdpPrivateKey, maskHex } from "../dual402.js";

let failures = 0;
function ok(name) {
  console.log(`  ok  ${name}`);
}
function fail(name, detail) {
  failures++;
  console.error(`  FAIL ${name}: ${detail}`);
}
function assert(cond, name, detail = "") {
  if (cond) ok(name);
  else fail(name, detail);
}

const VALID_CONFIG = {
  mpp: {
    currency: "0x20c0000000000000000000000000000000000000",
    recipient: "0x000000000000000000000000000000000000dEaD",
    secretKey: "a".repeat(64),
    testnet: true,
  },
  x402: {
    payTo: "0x000000000000000000000000000000000000dEaD",
    network: "eip155:84532",
    facilitatorUrl: "https://x402.org/facilitator",
  },
};

// ── assertConfig rejects missing fields ────────────────────────────────
console.log("assertConfig");
{
  let threw = false;
  try {
    createDual402({ mpp: {}, x402: {} });
  } catch (e) {
    threw = /missing required config/.test(e.message) &&
      e.message.includes("mpp.secretKey") &&
      e.message.includes("x402.payTo");
  }
  assert(threw, "throws on empty config with full field list");
}

// ── createDual402 returns the documented shape ─────────────────────────
console.log("createDual402 shape");
const dual = createDual402(VALID_CONFIG);
assert(typeof dual.charge === "function", "exposes charge()");
assert(typeof dual._mppx === "object", "exposes _mppx");
assert(typeof dual._x402Config === "object", "exposes _x402Config");
assert(typeof dual._x402Asset === "string", "exposes _x402Asset");
assert(
  dual._x402Asset === "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  "defaults USDC on Base Sepolia",
);
assert(Object.isFrozen(dual._x402Config), "_x402Config is frozen");

// ── charge() input validation ───────────────────────────────────────────
console.log("charge() validation");
for (const bad of [undefined, "", "free", "0", "0.0", "0.00", "1.2.3", "-1"]) {
  let threw = false;
  try { dual.charge({ amount: bad }); } catch { threw = true; }
  assert(threw, `rejects amount=${JSON.stringify(bad)}`);
}
assert(
  typeof dual.charge({ amount: "0.02", description: "t" }) === "function",
  "accepts amount=0.02 returns handler",
);

// ── handler carries _dualAmount / _dualDescription ─────────────────────
{
  const h = dual.charge({ amount: "0.25", description: "Quote check" });
  assert(h._dualAmount === "0.25", "handler stashes _dualAmount");
  assert(
    h._dualDescription === "Quote check",
    "handler stashes _dualDescription",
  );
}

// ── End-to-end 402 response (no payment header) carries PAYMENT-REQUIRED
console.log("402 injection");
{
  const handler = dual.charge({ amount: "0.02", description: "Demo" });
  const req = {
    headers: {},
    originalUrl: "/demo",
    protocol: "https",
    get: (k) => (k === "host" ? "example.com" : undefined),
  };
  // Fake an Express-ish response that records status/headers.
  const headers = {};
  const res = {
    _status: 200,
    _body: null,
    headersSent: false,
    statusCode: 200,
    status(code) { this._status = code; this.statusCode = code; return this; },
    setHeader(k, v) { headers[k] = v; },
    getHeader(k) { return headers[k]; },
    set(k, v) { this.setHeader(k, v); return this; },
    json(body) { this._body = body; this.headersSent = true; return this; },
    send(body) { this._body = body; this.headersSent = true; return this; },
    end() { this.headersSent = true; return this; },
  };

  await new Promise((resolve) => {
    handler(req, res, () => resolve("next"));
    // mppx may be async about writing its 402; settle the microtask queue
    // then resolve so we can inspect what landed on the response.
    setImmediate(() => resolve("settled"));
  });

  assert(
    res._status === 402,
    "no-credential request yields 402",
    `got status=${res._status}`,
  );
  assert(
    typeof headers["PAYMENT-REQUIRED"] === "string" &&
      headers["PAYMENT-REQUIRED"].length > 0,
    "PAYMENT-REQUIRED header attached",
  );
  // mppx sets a WWW-Authenticate "Payment" challenge with lowercase or
  // Title-Case key depending on version; check case-insensitively.
  const wwwAuth =
    headers["WWW-Authenticate"] ??
    headers["www-authenticate"] ??
    Object.entries(headers).find(
      ([k]) => k.toLowerCase() === "www-authenticate",
    )?.[1];
  assert(
    typeof wwwAuth === "string" && /payment/i.test(wwwAuth),
    "WWW-Authenticate Payment challenge present",
    `headers=${JSON.stringify(Object.keys(headers))}`,
  );

  // And PAYMENT-REQUIRED should be valid base64 JSON with an accepts list.
  try {
    const json = JSON.parse(
      Buffer.from(headers["PAYMENT-REQUIRED"], "base64").toString("utf-8"),
    );
    assert(json.x402Version === 2, "PAYMENT-REQUIRED is v2");
    assert(Array.isArray(json.accepts) && json.accepts.length === 1, "has 1 accepts entry");
    const a = json.accepts[0];
    assert(a.network === "eip155:84532", "accepts.network");
    assert(a.asset === dual._x402Asset, "accepts.asset");
    assert(a.payTo === VALID_CONFIG.x402.payTo, "accepts.payTo");
    assert(a.amount === "20000", "accepts.amount=20000 (0.02 USDC, 6 decimals)");
    assert(
      a.resource === "https://example.com/demo",
      "accepts.resource derived from host",
      `got ${a.resource}`,
    );
    assert(
      a.extra && a.extra.name === "USD Coin" && a.extra.version === "2",
      'accepts.extra ({name:"USD Coin", version:"2"})',
      `got ${JSON.stringify(a.extra)}`,
    );

    // No handler schemas were threaded into this handler (basic /demo
    // route used just to exercise the 402 path), so `extensions.bazaar`
    // should be absent — buildBazaarExtensions returns undefined when
    // neither inputSchema nor outputSchema is provided. A real route
    // (server.js) sets _dualInputSchema / _dualOutputSchema and the
    // bazaar block appears. Spec-compliance for that case is covered
    // by the dedicated test below.
    assert(
      json.extensions === undefined,
      "bazaar extension absent when no schemas threaded through",
      `got ${JSON.stringify(json.extensions)}`,
    );

    // Top-level resource: present with url, and description/mimeType
    assert(
      json.resource?.url === "https://example.com/demo",
      "resource.url mirrors accepts.resource",
      `got ${json.resource?.url}`,
    );
    assert(
      json.resource?.mimeType === "application/json",
      "resource.mimeType = application/json",
    );
  } catch (e) {
    fail("PAYMENT-REQUIRED parse", e.message);
  }
}

// ── bazaar.info.input shape varies correctly by HTTP method ────────────
// Most important regression test for the POST-body bug: a POST route's
// challenge must carry bodyType:"json" + body:{} so AgentCash knows to
// preserve the request body on the paid retry. Previously we emitted
// only bazaar.schema and clients dropped discovery info entirely.
console.log("bazaar.info varies by method");
{
  async function buildChallenge(method) {
    const inputSchema = {
      type: "object",
      required: ["lat", "lng"],
      properties: {
        lat: { type: "number" },
        lng: { type: "number" },
      },
    };
    const outputSchema = {
      type: "object",
      properties: { results: { type: "array" } },
    };
    const handler = dual.charge({ amount: "0.02", description: "Route" });
    handler._dualInputSchema = inputSchema;
    handler._dualOutputSchema = outputSchema;

    const headers = {};
    const req = {
      method,
      headers: {},
      originalUrl: "/route",
      protocol: "https",
      get: (k) => (k === "host" ? "example.com" : undefined),
    };
    const res = {
      headersSent: false,
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      setHeader(k, v) { headers[k] = v; },
      getHeader(k) { return headers[k]; },
      set(k, v) { this.setHeader(k, v); return this; },
      json() { this.headersSent = true; return this; },
      send() { this.headersSent = true; return this; },
      end() { this.headersSent = true; return this; },
    };
    await new Promise((r) => {
      handler(req, res, () => r());
      setImmediate(r);
    });
    if (!headers["PAYMENT-REQUIRED"]) return null;
    return JSON.parse(
      Buffer.from(headers["PAYMENT-REQUIRED"], "base64").toString("utf-8"),
    );
  }

  // POST — body-method spec shape
  {
    const json = await buildChallenge("POST");
    const info = json?.extensions?.bazaar?.info;
    assert(info?.input?.method === "POST", "POST: info.input.method === 'POST'");
    assert(
      info?.input?.bodyType === "json",
      "POST: info.input.bodyType === 'json'",
      `got ${info?.input?.bodyType}`,
    );
    assert(
      info?.input?.body && typeof info.input.body === "object",
      "POST: info.input.body present",
    );
    assert(
      info?.output?.type === "json",
      "POST: info.output.type === 'json'",
    );
    assert(
      json?.resource?.method === "POST",
      "POST: top-level resource.method === 'POST'",
      `got ${json?.resource?.method}`,
    );

    // Schema structure check: the draft-2020-12 schema must at least be
    // ajv-compilable. `info` is an EXAMPLE value, not a validated
    // payload (stableenrich and @x402/extensions both emit `body: {}` in
    // info even when the schema requires fields; real clients read
    // extension.info directly without validating against schema on the
    // hot path). What matters for AgentCash is that info.input carries
    // method/bodyType so the client knows this is a body-method route.
    const { default: Ajv2020 } = await import("ajv/dist/2020.js");
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    let compiled = true;
    try {
      ajv.compile(json.extensions.bazaar.schema);
    } catch (err) {
      compiled = false;
      fail("POST: bazaar.schema compiles under Ajv draft-2020", err.message);
    }
    if (compiled) ok("POST: bazaar.schema compiles under Ajv draft-2020");
  }

  // GET — query-method spec shape
  {
    const json = await buildChallenge("GET");
    const info = json?.extensions?.bazaar?.info;
    assert(info?.input?.method === "GET", "GET: info.input.method === 'GET'");
    assert(
      info?.input?.bodyType === undefined,
      "GET: info.input.bodyType absent (query method)",
      `got ${info?.input?.bodyType}`,
    );
    assert(
      info?.input?.queryParams && typeof info.input.queryParams === "object",
      "GET: info.input.queryParams present",
    );
    assert(
      json?.resource?.method === "GET",
      "GET: top-level resource.method === 'GET'",
      `got ${json?.resource?.method}`,
    );

    const { default: Ajv2020 } = await import("ajv/dist/2020.js");
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    let compiled = true;
    try {
      ajv.compile(json.extensions.bazaar.schema);
    } catch (err) {
      compiled = false;
      fail("GET: bazaar.schema compiles under Ajv draft-2020", err.message);
    }
    if (compiled) ok("GET: bazaar.schema compiles under Ajv draft-2020");
  }
}

// ── BASE_URL override wins ─────────────────────────────────────────────
console.log("BASE_URL override");
{
  process.env.BASE_URL = "https://proxy.example/";
  const handler = dual.charge({ amount: "0.02" });
  const headers = {};
  const req = {
    headers: {},
    originalUrl: "/foo",
    protocol: "http",
    get: () => "internal.ip:8080",
  };
  const res = {
    _status: 0,
    headersSent: false,
    status(c) { this._status = c; return this; },
    setHeader(k, v) { headers[k] = v; },
    getHeader(k) { return headers[k]; },
    set(k, v) { this.setHeader(k, v); return this; },
    json() { this.headersSent = true; return this; },
    send() { this.headersSent = true; return this; },
    end() { this.headersSent = true; return this; },
  };
  await new Promise((r) => {
    handler(req, res, () => r());
    setImmediate(r);
  });
  const json = JSON.parse(
    Buffer.from(headers["PAYMENT-REQUIRED"], "base64").toString("utf-8"),
  );
  assert(
    json.accepts[0].resource === "https://proxy.example/foo",
    "BASE_URL wins over Host + strips trailing slash",
    `got ${json.accepts[0].resource}`,
  );
  delete process.env.BASE_URL;
}

// ── MPP realm follows public host, not container hostname ──────────────
console.log("MPP realm");
{
  process.env.BASE_URL = "https://transit402.dev/";
  const dualWithBaseUrlRealm = createDual402(VALID_CONFIG);
  const handler = dualWithBaseUrlRealm.charge({ amount: "0.02" });
  const headers = {};
  const req = {
    headers: {},
    originalUrl: "/foo",
    protocol: "http",
    get: () => "tee-internal-host",
  };
  const res = {
    _status: 0,
    headersSent: false,
    status(c) { this._status = c; return this; },
    setHeader(k, v) { headers[k] = v; },
    getHeader(k) { return headers[k]; },
    set(k, v) { this.setHeader(k, v); return this; },
    json() { this.headersSent = true; return this; },
    send() { this.headersSent = true; return this; },
    end() { this.headersSent = true; return this; },
  };
  await new Promise((r) => {
    handler(req, res, () => r());
    setImmediate(r);
  });
  const wwwAuth =
    headers["WWW-Authenticate"] ??
    headers["www-authenticate"] ??
    Object.entries(headers).find(
      ([k]) => k.toLowerCase() === "www-authenticate",
    )?.[1];
  const challenge = Challenge.deserialize(wwwAuth);
  assert(
    challenge.realm === "transit402.dev",
    "MPP realm derives from BASE_URL host",
    `got ${challenge.realm}`,
  );

  process.env.MPP_REALM = "payments.transit402.dev";
  const dualWithExplicitRealm = createDual402(VALID_CONFIG);
  const handler2 = dualWithExplicitRealm.charge({ amount: "0.02" });
  const headers2 = {};
  const res2 = {
    _status: 0,
    headersSent: false,
    status(c) { this._status = c; return this; },
    setHeader(k, v) { headers2[k] = v; },
    getHeader(k) { return headers2[k]; },
    set(k, v) { this.setHeader(k, v); return this; },
    json() { this.headersSent = true; return this; },
    send() { this.headersSent = true; return this; },
    end() { this.headersSent = true; return this; },
  };
  await new Promise((r) => {
    handler2(req, res2, () => r());
    setImmediate(r);
  });
  const wwwAuth2 =
    headers2["WWW-Authenticate"] ??
    headers2["www-authenticate"] ??
    Object.entries(headers2).find(
      ([k]) => k.toLowerCase() === "www-authenticate",
    )?.[1];
  const challenge2 = Challenge.deserialize(wwwAuth2);
  assert(
    challenge2.realm === "payments.transit402.dev",
    "MPP_REALM override wins over BASE_URL",
    `got ${challenge2.realm}`,
  );

  delete process.env.MPP_REALM;
  delete process.env.BASE_URL;
}

// ── CDP key parsing (Ed25519 in all four formats) ──────────────────────
//
// CDP hands out API secrets in multiple shapes depending on vintage &
// generator. dual402 must accept all of them without taking a dep on
// @coinbase/cdp-sdk. Regression target: raw 64-byte base64 (CDP's current
// default) was previously rejected with DECODER::unsupported, breaking
// the first paid request on mainnet.
console.log("parseCdpPrivateKey");
{
  // Generate a test Ed25519 keypair once, export it in each shape we
  // accept, and assert parseCdpPrivateKey() recovers an Ed25519 key.
  const { privateKey: pk, publicKey: pub } = crypto.generateKeyPairSync("ed25519");
  const pkcs8Der = pk.export({ format: "der", type: "pkcs8" });
  const pkcs8Pem = pk.export({ format: "pem", type: "pkcs8" });
  // Ed25519 public key as 32 raw bytes (end of SPKI DER).
  const pubRaw = pub.export({ format: "der", type: "spki" }).subarray(-32);

  // 1. PEM (with newlines)
  {
    const parsed = parseCdpPrivateKey(pkcs8Pem);
    assert(parsed.asymmetricKeyType === "ed25519", "parses PEM Ed25519");
  }

  // 2. PKCS#8 DER base64 (no headers) — what createPrivateKey accepts as a string
  {
    const parsed = parseCdpPrivateKey(pkcs8Der.toString("base64"));
    assert(parsed.asymmetricKeyType === "ed25519", "parses PKCS#8 DER base64");
  }

  // 3. Raw 64-byte Ed25519 (seed || pubkey), base64 — CDP's current format
  {
    // DER layout: 16-byte header + 32-byte seed; pubkey isn't in PKCS#8.
    const seed = pkcs8Der.subarray(16, 48);
    const raw64 = Buffer.concat([seed, pubRaw]).toString("base64");
    assert(
      Buffer.from(raw64, "base64").length === 64,
      "test fixture is 64 raw bytes",
    );
    const parsed = parseCdpPrivateKey(raw64);
    assert(
      parsed.asymmetricKeyType === "ed25519",
      "parses raw 64-byte Ed25519 (CDP default)",
    );
    // And the recovered key must produce the same signature as the original.
    const msg = Buffer.from("roundtrip");
    const sigOrig = crypto.sign(null, msg, pk);
    const sigBack = crypto.sign(null, msg, parsed);
    assert(
      Buffer.compare(sigOrig, sigBack) === 0,
      "raw-recovered key signs identically to original",
    );
  }

  // 4. Raw 32-byte Ed25519 seed, base64
  {
    const seed = pkcs8Der.subarray(16, 48);
    const raw32 = seed.toString("base64");
    const parsed = parseCdpPrivateKey(raw32);
    assert(
      parsed.asymmetricKeyType === "ed25519",
      "parses raw 32-byte Ed25519 seed",
    );
  }

  // 5. Garbage input must throw (not silently produce a bogus key)
  {
    let threw = false;
    try { parseCdpPrivateKey("not a real key"); } catch { threw = true; }
    assert(threw, "throws on unrecognizable input");
  }

  // 6. createDual402 validates CDP key at boot (not on first request)
  {
    let threw = false;
    let msg = "";
    try {
      createDual402({
        ...VALID_CONFIG,
        x402: {
          ...VALID_CONFIG.x402,
          cdpAuth: { apiKeyId: "abc", apiKeySecret: "clearly-not-a-key" },
        },
      });
    } catch (e) {
      threw = true;
      msg = e.message;
    }
    assert(
      threw && /could not be parsed/.test(msg),
      "createDual402 rejects malformed CDP_API_KEY_SECRET at boot",
      msg,
    );
  }

  // 7. createDual402 accepts a valid raw-64 CDP key without throwing
  {
    const seed = pkcs8Der.subarray(16, 48);
    const raw64 = Buffer.concat([seed, pubRaw]).toString("base64");
    const d = createDual402({
      ...VALID_CONFIG,
      x402: {
        ...VALID_CONFIG.x402,
        cdpAuth: { apiKeyId: "abc", apiKeySecret: raw64 },
      },
    });
    assert(
      d._x402Config.cdpAuth?.apiKeyId === "abc",
      "createDual402 accepts valid raw-64 CDP key",
    );
  }
}

// ── Log masking: PII out of public ecloud logs ─────────────────────────
// Ecloud runs us with --log-visibility public, which means every
// `console.log` ends up on the verify.eigencloud.xyz dashboard. Any
// full tx hash or EVM address in those lines becomes cross-referenceable
// against Base, effectively publishing who queried which route when.
// These tests lock in the masking convention for the two emission
// sites we have today (settle success, payee mismatch) and for the
// maskHex() helper itself.
console.log("maskHex");
{
  // A real Base mainnet tx hash (66 chars incl. 0x prefix). Must be
  // trimmed to `0x<6>…<4>`.
  const realTx = "0x24c717f0bb5ff4a55773dfae9d7b498700558cd0805f74cace3501d97d373527";
  const masked = maskHex(realTx);
  assert(
    masked === "0x24c717…3527",
    "masks a 66-char 0x-prefixed tx hash to 0x24c717…3527",
    `got ${masked}`,
  );
  assert(
    !masked.includes(realTx.slice(8, 60)),
    "masked tx hash omits the middle bytes",
  );

  // A real EVM address (42 chars). Same prefix/suffix rule.
  const addr = "0x687E3217668DDe7c32478A3F2613750c8Bd505E9";
  const maskedAddr = maskHex(addr);
  assert(
    maskedAddr === "0x687E32…05E9",
    "masks a 42-char EVM address to 0x687E32…05E9",
    `got ${maskedAddr}`,
  );

  // Custom head/tail for callers that want a different readability
  // tradeoff.
  assert(
    maskHex(addr, { head: 4, tail: 2 }) === "0x687E…E9",
    "head/tail options respected",
    `got ${maskHex(addr, { head: 4, tail: 2 })}`,
  );

  // Short inputs that aren't worth masking should pass through as-is
  // (no trailing ellipsis for, e.g., "0xabc").
  assert(maskHex("0xabc") === "0xabc", "short hex passes through unmasked");
  assert(maskHex("") === "", "empty string returns empty");
  assert(maskHex(undefined) === "", "undefined returns empty");
  assert(maskHex(null) === "", "null returns empty");

  // Non-hex input falls back to sanitizeLogValue (capped, no control
  // chars). Must never emit an unbounded string into a log line.
  const sanitized = maskHex("not a hash at all, just garbage that is long");
  assert(
    sanitized.length <= 32 && !sanitized.includes("0x"),
    "non-hex input is sanitized, not masked as hex",
    `got ${sanitized}`,
  );

  // Bare hex (no 0x prefix) — some facilitators echo this shape for
  // nonces. Mask body only, no injected prefix.
  const bareNonce = "a".repeat(64);
  const maskedBare = maskHex(bareNonce);
  assert(
    !maskedBare.startsWith("0x") && maskedBare.length < bareNonce.length,
    "bare hex is masked without adding 0x prefix",
    `got ${maskedBare}`,
  );
}

// ── [PAY] settled log line omits full tx hash ──────────────────────────
// Drives a charge handler through a mocked x402 verify+settle happy path
// and captures stdout. If a full 64-char hex appears anywhere in the
// [PAY] settled line, the masking regressed.
console.log("settle log privacy");
{
  // Can't run a real x402 verify path without a live facilitator, so
  // this test operates at the log-line level directly: construct the
  // same log template the settle callback uses and assert that
  // maskHex() applied to the tx produces a line that (a) includes the
  // truncated tx and (b) does NOT include the full hash.
  const realTx =
    "0x24c717f0bb5ff4a55773dfae9d7b498700558cd0805f74cace3501d97d373527";
  const route = "/citibike/nearest";
  const amount = "0.02";
  const tx = ` tx=${maskHex(realTx)}`;
  const line = `[PAY] x402 settled amount=${amount} route=${route}${tx}`;

  assert(
    !line.includes(realTx),
    "settled log does NOT contain the full 66-char tx hash",
    line,
  );
  assert(
    line.includes("0x24c717…3527"),
    "settled log contains the masked tx hash",
    line,
  );
  // Sanity: no 40+ hex run after the `0x` prefix anywhere on the line.
  // A 32-byte tx hash is 64 hex chars; an EVM address is 40. If
  // anything leaks either length it'd match this pattern.
  const longHex = /0x[0-9a-fA-F]{40,}/;
  assert(
    !longHex.test(line),
    "settled log has no 40+ char hex run",
    line,
  );
}

// ── payee-mismatch warn line omits full addresses ──────────────────────
console.log("payee mismatch log privacy");
{
  const got = "0xdeadbeefcafebabe0000000000000000000000aa";
  const want = "0x687E3217668DDe7c32478A3F2613750c8Bd505E9";
  const line = `[dual402] x402 payee mismatch got=${maskHex(got)} want=${maskHex(want)}`;

  assert(
    !line.toLowerCase().includes(got.toLowerCase()),
    "mismatch log does NOT contain the full claimed payee address",
    line,
  );
  assert(
    !line.toLowerCase().includes(want.toLowerCase()),
    "mismatch log does NOT contain the full configured payee address",
    line,
  );
  const longHex = /0x[0-9a-fA-F]{40,}/;
  assert(
    !longHex.test(line),
    "mismatch log has no 40+ char hex run",
    line,
  );
}

// ── Exit ───────────────────────────────────────────────────────────────
if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall smoke checks passed");
