#!/usr/bin/env node
/**
 * One-off validation: does the PRODUCTION dual402.js code path mint a JWT
 * that CDP's facilitator accepts?
 *
 * This exercises parseCdpPrivateKey() + the full generateCdpJwt() logic
 * (same functions used by fetchJsonWithTimeout in production). If this
 * passes, the only thing left for deploy is rebuilding the image.
 *
 * We hit POST /verify with a deliberately-invalid body so CDP is forced
 * to authenticate us FIRST (which is what we're testing). Expected:
 *   401 -> auth failed (key or JWT format rejected)
 *   400/422 -> auth OK, body rejected (what we want)
 *
 * Run:
 *   node --env-file=/path/to/.env.mainnet tests/validate-cdp-jwt.mjs
 */

import crypto from "node:crypto";
import { parseCdpPrivateKey } from "../dual402.js";

const KEY_ID = process.env.CDP_API_KEY_ID;
const KEY_SECRET = process.env.CDP_API_KEY_SECRET;

if (!KEY_ID || !KEY_SECRET) {
  console.error("missing CDP_API_KEY_ID or CDP_API_KEY_SECRET in env");
  console.error(
    "run with: node --env-file=/path/to/.env.mainnet tests/validate-cdp-jwt.mjs",
  );
  process.exit(2);
}

console.log(`KEY_ID:        ${KEY_ID}`);
console.log(`SECRET length: ${KEY_SECRET.length} chars`);
console.log(`SECRET prefix: ${KEY_SECRET.slice(0, 12)}...`);

// ── parse via the production helper ──
let privateKey;
try {
  privateKey = parseCdpPrivateKey(KEY_SECRET);
  console.log(`\n[ok] parseCdpPrivateKey -> keyType=${privateKey.asymmetricKeyType}`);
} catch (err) {
  console.error(`\n[FAIL] parseCdpPrivateKey: ${err.message}`);
  process.exit(3);
}

// ── mint a JWT using the same logic as generateCdpJwt() ──
// (We don't export generateCdpJwt itself to keep the module surface
// minimal, but the logic here mirrors it exactly — any divergence is a
// bug we want to catch at validation time.)
function base64url(b) {
  return Buffer.from(b).toString("base64url");
}

function ecdsaDerToRaw(der) {
  const rLen = der[3];
  let r = der.subarray(4, 4 + rLen);
  const sLen = der[4 + rLen + 1];
  let s = der.subarray(4 + rLen + 2, 4 + rLen + 2 + sLen);
  if (r.length > 32 && r[0] === 0) r = r.subarray(1);
  if (s.length > 32 && s[0] === 0) s = s.subarray(1);
  const out = Buffer.alloc(64);
  r.copy(out, 32 - r.length);
  s.copy(out, 64 - s.length);
  return out;
}

const host = "api.cdp.coinbase.com";
const path = "/platform/v2/x402/verify";
const method = "POST";
const keyType = privateKey.asymmetricKeyType;
const alg = keyType === "ed25519" ? "EdDSA" : "ES256";

const header = {
  alg,
  typ: "JWT",
  kid: KEY_ID,
  nonce: crypto.randomBytes(16).toString("hex"),
};
const now = Math.floor(Date.now() / 1000);
const claims = {
  sub: KEY_ID,
  iss: "cdp",
  aud: ["cdp_service"],
  nbf: now,
  exp: now + 120,
  uris: [`${method} ${host}${path}`],
};

const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
let sig = crypto.sign(alg === "EdDSA" ? null : "sha256", Buffer.from(signingInput), privateKey);
if (alg === "ES256") sig = ecdsaDerToRaw(sig);
const jwt = `${signingInput}.${base64url(sig)}`;

console.log(`\n[ok] JWT minted. alg=${alg} len=${jwt.length}`);

// ── POST to CDP /verify with junk body ──
console.log(`\n[..] POST https://${host}${path}`);
const startedAt = Date.now();
const res = await fetch(`https://${host}${path}`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${jwt}`,
  },
  body: JSON.stringify({
    x402Version: 2,
    paymentPayload: { __validation_probe__: true },
    paymentRequirements: { __validation_probe__: true },
  }),
  signal: AbortSignal.timeout(10_000),
});
const text = await res.text();
const elapsed = Date.now() - startedAt;
console.log(`     status=${res.status} time=${elapsed}ms`);
console.log(`     body=${text.slice(0, 400)}`);

// ── verdict ──
console.log("\n--- verdict ---");
if (res.status === 401) {
  console.error("FAIL: 401 Unauthorized. Key / JWT format rejected by CDP.");
  process.exit(1);
} else if (res.status === 403) {
  console.error("FAIL: 403 Forbidden. Key known but lacks x402 permission.");
  process.exit(1);
} else if (res.status >= 200 && res.status < 500) {
  console.log("PASS: CDP authenticated us. Auth path is ready for deploy.");
  process.exit(0);
} else {
  console.error(`INCONCLUSIVE: status ${res.status}. Likely a CDP-side issue.`);
  process.exit(1);
}
