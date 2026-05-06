/**
 * dual402.js — Express middleware that accepts BOTH x402 and MPP payments
 * on the same route. Single 402 response carries both protocol challenges,
 * so agents that speak either protocol can pay without a pre-flight.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *                               WHY ONE FILE
 * ─────────────────────────────────────────────────────────────────────────
 *   - The x402 side is pure HTTP — no SDK needed — so every step is visible
 *     and auditable from this file alone.
 *   - The MPP side delegates to the `mppx` Express middleware and we only
 *     layer the x402 challenge header on top of its 402.
 *   - Keep this file copy-pastable as a reference for dual-protocol paid
 *     APIs. Any change here should preserve that property.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *                             DESIGN DECISIONS
 * ─────────────────────────────────────────────────────────────────────────
 *   - Fail-closed facilitator timeout: every call to /verify and /settle is
 *     bounded by FACILITATOR_TIMEOUT_MS (default 5s, env-overridable). A
 *     hung facilitator must not hang every paid request.
 *   - STRICT local guards: the payment payload MUST carry both amount and
 *     payTo, and they MUST match what this route charges, before we even
 *     call the facilitator. A misconfigured or compromised facilitator is
 *     therefore not the sole authority on "is this payment correct for
 *     this route".
 *   - Settlement is fire-and-forget AFTER next(). The merchant accepts a
 *     small exposure window between verify and settle in exchange for
 *     fast responses. Failures are logged loudly with route context so
 *     on-call can spot verify-succeeded-but-settle-failed drift. For
 *     higher-value routes, pass `waitForSettle: true` to `dual.charge()`
 *     and settlement is awaited (and enforced) before `next()`.
 *   - res.status is monkey-patched PER REQUEST (never on the prototype).
 *     res is a fresh object each request, so patching is scoped correctly.
 *     The patch is also a no-op for codes other than 402.
 *   - Log hygiene: we never log payment signatures, raw payloads, private
 *     keys, or full wallet balances. On a mismatch we log the offending
 *     counterparty address (lowercased) and a machine-readable reason code.
 *     Verify/settle success lines carry only amount + route + optional
 *     txHash (from the facilitator, not from the client).
 *
 * ─────────────────────────────────────────────────────────────────────────
 *                              QUICK EXAMPLE
 * ─────────────────────────────────────────────────────────────────────────
 *   import express from "express";
 *   import { createDual402, dualDiscovery } from "./dual402.js";
 *
 *   const dual = createDual402({
 *     mpp: {
 *       currency: process.env.USDC_TEMPO,
 *       recipient: process.env.MPP_RECIPIENT,
 *       secretKey: process.env.MPP_SECRET_KEY,
 *       testnet: process.env.MPP_TESTNET === "true",
 *     },
 *     x402: {
 *       payTo: process.env.X402_PAYEE_ADDRESS,
 *       network: process.env.X402_NETWORK,            // e.g. "eip155:8453"
 *       facilitatorUrl: process.env.X402_FACILITATOR_URL,
 *     },
 *   });
 *
 *   const chargeQuote = dual.charge({ amount: "0.02", description: "Quote" });
 *
 *   const app = express();
 *   app.get("/quote", chargeQuote, (req, res) => res.json({ price: 42 }));
 *
 *   dualDiscovery(app, dual, {
 *     info: { title: "My API", version: "1.0.0", description: "..." },
 *     routes: [{
 *       method: "get", path: "/quote", handler: chargeQuote,
 *       operationId: "get-quote", summary: "Get quote",
 *     }],
 *   });
 *   app.listen(8080);
 *
 * ─────────────────────────────────────────────────────────────────────────
 *                              ENVIRONMENT
 * ─────────────────────────────────────────────────────────────────────────
 *   Required (checked at createDual402() time; throws on missing):
 *     MPP_SECRET_KEY           HMAC key for mppx challenges
 *     USDC_TEMPO               Tempo USDC token address
 *     MPP_RECIPIENT            MPP payee wallet (or RECIPIENT_WALLET)
 *     X402_PAYEE_ADDRESS       x402 payee wallet (or RECIPIENT_WALLET)
 *     X402_NETWORK             CAIP-2 id, e.g. "eip155:8453"
 *     X402_FACILITATOR_URL     e.g. https://x402.org/facilitator
 *   Optional:
 *     BASE_URL                 Public URL advertised in challenges
 *     MPP_REALM                Hostname advertised in MPP challenges
 *     X402_FACILITATOR_TIMEOUT_MS   Default 5000
 *     MPP_TESTNET              "true" to use Tempo testnet
 *     CDP_API_KEY_ID           CDP API key id (only for CDP facilitator)
 *     CDP_API_KEY_SECRET       CDP API key secret (only for CDP facilitator)
 */

import { Mppx, tempo } from "mppx/express";
import crypto from "node:crypto";

// ── CDP JWT (zero-dep, handles Ed25519 + ECDSA P-256) ──────────────────
//
// Mint a CDP-compatible Bearer JWT for api.cdp.coinbase.com requests.
// We don't take a dep on @coinbase/cdp-sdk just for this one helper —
// it costs ~1300 lockfile lines (pulls viem, jose, etc.). Node's built-in
// `node:crypto` can sign Ed25519 and ECDSA P-256 natively, so we build
// the JWT by hand.
//
// CDP JWT format (per CDP docs: docs.cdp.coinbase.com/get-started/authentication/jwt-authentication):
//   Header  { alg, typ: "JWT", kid, nonce }   alg is "EdDSA" or "ES256"
//   Claims  { sub, iss:"cdp", aud:["cdp_service"], nbf, exp, uris:[METHOD host+path] }
//   Sig     Ed25519 (no prehash) or ECDSA-SHA256, signed over header.claims
//           ECDSA signatures come out of Node as DER — JWT spec needs raw r||s.
//
// Token TTL is 120s per CDP recommendation. A fresh JWT is minted per
// facilitator request (cheap — signing is microseconds).

function base64url(data) {
  return Buffer.from(data).toString("base64url");
}

/**
 * Convert a DER-encoded ECDSA signature to raw r||s (64 bytes for P-256).
 * JWT (RFC 7515) expects the raw form; Node's crypto.sign returns DER.
 * Handles the leading-zero cases DER uses to distinguish positive ints.
 */
function ecdsaDerToRaw(der) {
  // DER: 0x30 <len> 0x02 <rLen> <r> 0x02 <sLen> <s>
  const rLen = der[3];
  let r = der.subarray(4, 4 + rLen);
  const sLen = der[4 + rLen + 1];
  let s = der.subarray(4 + rLen + 2, 4 + rLen + 2 + sLen);
  // Strip any DER sign-extension leading 0x00 byte.
  if (r.length > 32 && r[0] === 0) r = r.subarray(1);
  if (s.length > 32 && s[0] === 0) s = s.subarray(1);
  const out = Buffer.alloc(64);
  r.copy(out, 32 - r.length);
  s.copy(out, 64 - s.length);
  return out;
}

// PKCS#8 DER prefix for an Ed25519 private key. Concatenated with a 32-byte
// seed it yields a valid PKCS#8-DER encoding that crypto.createPrivateKey
// accepts. CDP hands out keys as a raw 64-byte base64 blob (seed || pubkey)
// with NO PKCS#8 wrapper — Node's createPrivateKey refuses that shape, so
// we wrap it ourselves rather than taking a dep on @coinbase/cdp-sdk.
const ED25519_PKCS8_DER_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex",
);

/**
 * Parse a CDP API secret in any format we've seen in the wild:
 *   1. PEM — "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
 *   2. PKCS#8 DER (base64) — what createPrivateKey() accepts as a string
 *   3. Raw 64-byte Ed25519 (base64, 88 chars) — seed || pubkey, CDP's
 *      default; createPrivateKey() rejects this with DECODER::unsupported
 *   4. Raw 32-byte Ed25519 seed (base64, 44 chars) — less common but
 *      some tooling emits just the seed
 *
 * For 3 and 4 we prepend the Ed25519 PKCS#8 header and pass DER bytes.
 * Throws on any unrecognizable input — we must not silently ship a key
 * the facilitator will reject on the first paid request.
 */
export function parseCdpPrivateKey(secret) {
  const s = String(secret).trim();
  // 1. PEM has distinctive -----BEGIN markers; hand to Node directly.
  if (s.includes("BEGIN")) {
    return crypto.createPrivateKey({ key: s, format: "pem" });
  }
  // 2. Try as-is first; this covers the base64-encoded PKCS#8 DER case
  // and any future format Node learns to auto-detect.
  try {
    return crypto.createPrivateKey(s);
  } catch {
    // fall through to raw handling
  }
  // 3. Base64-decode and dispatch on byte length:
  //    - 48 bytes = PKCS#8 DER (Ed25519 header + seed), hand to Node as DER
  //    - 64 bytes = raw Ed25519 (seed || pubkey), wrap in PKCS#8
  //    - 32 bytes = raw Ed25519 seed, wrap in PKCS#8
  let raw;
  try {
    raw = Buffer.from(s, "base64");
  } catch (err) {
    throw new Error(`cdp_key_unrecognized: not base64 (${err.message})`);
  }
  if (raw.length === 48) {
    try {
      return crypto.createPrivateKey({ key: raw, format: "der", type: "pkcs8" });
    } catch (err) {
      throw new Error(`cdp_key_unrecognized: 48-byte base64 blob is not PKCS#8 DER (${err.message})`);
    }
  }
  const seed = raw.length === 64 ? raw.subarray(0, 32) : raw.length === 32 ? raw : null;
  if (!seed) {
    throw new Error(
      `cdp_key_unrecognized: expected PEM, PKCS#8 DER (48 bytes), or raw Ed25519 (32/64 bytes); got ${raw.length} bytes`,
    );
  }
  return crypto.createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_DER_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
}

function generateCdpJwt({
  apiKeyId,
  apiKeySecret,
  requestMethod,
  requestHost,
  requestPath,
  expiresIn = 120,
}) {
  const privateKey = parseCdpPrivateKey(apiKeySecret);
  const keyType = privateKey.asymmetricKeyType; // "ed25519" or "ec"

  let alg;
  if (keyType === "ed25519") alg = "EdDSA";
  else if (keyType === "ec") alg = "ES256";
  else throw new Error(`cdp_jwt_unsupported_key_type:${keyType}`);

  const header = {
    alg,
    typ: "JWT",
    kid: apiKeyId,
    nonce: crypto.randomBytes(16).toString("hex"),
  };
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    sub: apiKeyId,
    iss: "cdp",
    aud: ["cdp_service"],
    nbf: now,
    exp: now + expiresIn,
    uris: [`${requestMethod} ${requestHost}${requestPath}`],
  };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;

  // Ed25519 has no separate hash stage; crypto.sign takes null.
  // ECDSA P-256 uses SHA-256 and returns DER that we must convert.
  let sig = crypto.sign(alg === "EdDSA" ? null : "sha256", Buffer.from(signingInput), privateKey);
  if (alg === "ES256") sig = ecdsaDerToRaw(sig);

  return `${signingInput}.${base64url(sig)}`;
}

// ── Types ───────────────────────────────────────────────────────────────

/**
 * @typedef {object} MppConfig
 * @property {string} currency    Tempo token address (USDC).
 * @property {string} recipient   MPP payment recipient wallet.
 * @property {string} secretKey   HMAC secret used by mppx for challenges.
 * @property {string} [realm]     Hostname advertised in MPP challenges.
 * @property {boolean} [testnet]  Use Tempo testnet if true (chain 42431).
 */

/**
 * @typedef {object} X402Config
 * @property {string} payTo             Recipient wallet (EVM address).
 * @property {string} network           CAIP-2 chain id (e.g. "eip155:8453").
 * @property {string} facilitatorUrl    Facilitator base URL (no trailing slash required).
 * @property {string} [asset]           USDC asset address. Defaults by network.
 * @property {{name: string, version: string}} [extra]
 *   EIP-712 domain params for the asset's EIP-3009 signature. Defaults to
 *   USDC's `{name: "USD Coin", version: "2"}` (matches the on-chain
 *   EIP-712 domain of USDC on Ethereum, Base, and Polygon — the token's
 *   `name()` getter returns "USD Coin", not "USDC", and the contract
 *   validates signatures against that exact string). Override when using
 *   a non-USDC
 *   stablecoin — clients need these to build a valid TransferWithAuthorization.
 * @property {number} [timeoutMs]       Override facilitator timeout (ms).
 * @property {{apiKeyId: string, apiKeySecret: string}} [cdpAuth]
 *   Coinbase Developer Platform API credentials. Required only when using
 *   Coinbase's hosted x402 facilitator (`api.cdp.coinbase.com/...`), which
 *   requires a per-request JWT Bearer token. When present, calls to CDP
 *   hosts attach `Authorization: Bearer <jwt>` minted with `node:crypto`
 *   (see `generateCdpJwt` above). Calls to any non-CDP facilitator
 *   (e.g. `x402.org/facilitator`, self-hosted) are unaffected.
 */

/**
 * @typedef {object} Dual402Config
 * @property {MppConfig}  mpp
 * @property {X402Config} x402
 * @property {(payload: object, ctx: { route: string, amount: string }) => (void | boolean | Promise<void | boolean>)} [onVerify]
 *   Optional hook invoked AFTER local amount/payee guards pass and BEFORE the
 *   facilitator is called. Return `false` (or throw) to reject the payment
 *   (e.g. for an application-owned nonce/replay cache). This is the seam
 *   for stateful replay protection — dual402 itself stays stateless.
 */

/**
 * @typedef {object} ChargeOpts
 * @property {string} amount            Human-readable USD amount, e.g. "0.02".
 * @property {string} [description]     Shown in 402 challenges and discovery.
 * @property {boolean} [waitForSettle]  If true, await facilitator /settle
 *   BEFORE calling next(). Trades ~1s of latency for receipt-before-service
 *   semantics. Recommended for high-value routes; default is fire-and-forget.
 */

/**
 * @typedef {object} VerifyResult
 * @property {boolean} valid
 * @property {string}  [reason]   Machine-readable reason code when invalid.
 * @property {string}  [txHash]   Settled tx hash when the facilitator returns one.
 * @property {object}  [payload]  The decoded payment payload (present when `valid`).
 *   Handed back so the caller can pass it to `x402Settle` without a second decode.
 */

// ── Defaults ────────────────────────────────────────────────────────────

/**
 * Default USDC addresses per CAIP-2 network. Override via `x402.asset` if
 * you want to charge a different stablecoin on one of these networks.
 */
const USDC_BY_NETWORK = {
  "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // Base Sepolia
  "eip155:8453":  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // Base Mainnet
  "eip155:1":     "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // Ethereum
};

/**
 * Bound on how long a facilitator can block us. Override via env var
 * `X402_FACILITATOR_TIMEOUT_MS` or per-instance via `x402.timeoutMs`.
 * Fail-closed on timeout (treats as invalid verification).
 */
const DEFAULT_FACILITATOR_TIMEOUT_MS = (() => {
  const env = Number.parseInt(process.env.X402_FACILITATOR_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(env) && env > 0 ? env : 5_000;
})();

// ── Factory ─────────────────────────────────────────────────────────────

/**
 * @param {Dual402Config} config
 * @returns {{
 *   _mppx: ReturnType<typeof Mppx.create>,
 *   _x402Config: { payTo: string, network: string, asset: string, extra: {name: string, version: string}, facilitatorUrl: string, timeoutMs: number },
 *   _x402Asset: string,
 *   charge(opts: ChargeOpts): import('express').RequestHandler
 * }}
 */
export function createDual402(config) {
  // Fail loudly on missing config — better than a mysterious 402 at runtime.
  assertConfig(config);
  const mppRealm = resolveMppRealm(config);

  const mppx = Mppx.create({
    methods: [
      tempo.charge({
        currency: config.mpp.currency,
        recipient: config.mpp.recipient,
        ...(config.mpp.testnet && { testnet: true }),
      }),
    ],
    secretKey: config.mpp.secretKey,
    ...(mppRealm && { realm: mppRealm }),
  });

  const x402Asset = config.x402.asset ?? USDC_BY_NETWORK[config.x402.network];
  if (!x402Asset) {
    throw new Error(
      `dual402: No default USDC for network "${config.x402.network}". ` +
        `Set x402.asset explicitly or pick a supported network: ${Object.keys(USDC_BY_NETWORK).join(", ")}.`,
    );
  }

  // Normalize facilitator URL — many SDKs are tolerant, but `${url}/verify`
  // with a trailing slash yields `//verify` which some gateways 404 on.
  const facilitatorUrl = String(config.x402.facilitatorUrl).replace(/\/+$/, "");
  const timeoutMs =
    Number.isFinite(config.x402.timeoutMs) && config.x402.timeoutMs > 0
      ? Number(config.x402.timeoutMs)
      : DEFAULT_FACILITATOR_TIMEOUT_MS;

  const onVerify = typeof config.onVerify === "function" ? config.onVerify : null;

  // Freeze the normalized x402 config so callers can't mutate it out from
  // under the request handlers. Every charge() closure below reads from
  // this copy — NEVER from the raw `config` argument — so there is exactly
  // one source of truth for payTo / network / asset.
  const x402Extra =
    config.x402.extra && typeof config.x402.extra === "object"
      ? Object.freeze({ ...config.x402.extra })
      : Object.freeze({ name: "USD Coin", version: "2" });

  // Optional CDP auth — only triggers for requests to api.cdp.coinbase.com.
  // Validate shape up front so a misconfigured env var fails at boot rather
  // than on the first paid request.
  let cdpAuth = null;
  if (config.x402.cdpAuth) {
    const { apiKeyId, apiKeySecret } = config.x402.cdpAuth;
    if (typeof apiKeyId !== "string" || apiKeyId.length === 0) {
      throw new Error(
        "dual402: x402.cdpAuth.apiKeyId is required when cdpAuth is set (env CDP_API_KEY_ID).",
      );
    }
    if (typeof apiKeySecret !== "string" || apiKeySecret.length === 0) {
      throw new Error(
        "dual402: x402.cdpAuth.apiKeySecret is required when cdpAuth is set (env CDP_API_KEY_SECRET).",
      );
    }
    // Parse once at boot. Catches format mismatches (e.g. ECDSA P-256 PEM
    // mistakenly set as the Ed25519 var) before a paid request hits. The
    // parsed key isn't cached — minting a JWT is microseconds, and the
    // caller may rotate the secret in-place via env reloads.
    try {
      parseCdpPrivateKey(apiKeySecret);
    } catch (err) {
      throw new Error(
        `dual402: CDP_API_KEY_SECRET could not be parsed as an Ed25519 or ECDSA key: ${err.message}. ` +
          `Expected PEM, PKCS#8 DER (base64), or a raw 32/64-byte Ed25519 key (base64).`,
      );
    }
    cdpAuth = Object.freeze({ apiKeyId, apiKeySecret });
  }

  const x402Config = Object.freeze({
    payTo: config.x402.payTo,
    network: config.x402.network,
    asset: x402Asset,
    extra: x402Extra,
    facilitatorUrl,
    timeoutMs,
    cdpAuth,
  });

  return {
    _mppx: mppx,
    _x402Config: x402Config,
    _x402Asset: x402Asset,

    /**
     * Returns Express middleware that gates a route behind payment.
     * Accepts both x402 (`PAYMENT-SIGNATURE`/`X-PAYMENT`) and MPP
     * (`Authorization: Payment ...`).
     *
     * @param {ChargeOpts} opts
     * @returns {import('express').RequestHandler}
     */
    charge(opts) {
      const { amount, description, waitForSettle = false } = opts;
      if (typeof amount !== "string" || !/^\d+(\.\d+)?$/.test(amount)) {
        throw new Error(
          `dual402.charge: amount must be a decimal string like "0.02" — got ${JSON.stringify(amount)}`,
        );
      }
      // Reject zero explicitly. "0", "0.0", "0.00" … all pass the regex
      // but a $0 route is almost always a config bug: the facilitator
      // will usually reject anyway, and if it doesn't, we'd silently
      // hand out paid content for free. Better to fail at boot.
      if (/^0+(\.0+)?$/.test(amount)) {
        throw new Error(
          `dual402.charge: amount must be > 0 — got ${JSON.stringify(amount)}. ` +
            `If you meant a free route, skip dual.charge() entirely.`,
        );
      }

      const mppCharge = mppx.charge({ amount, description });

      // x402 amount in the asset's smallest unit (USDC = 6 decimals).
      // Uses string-based integer math to dodge binary-float rounding for
      // sub-cent amounts and THROWS if the input has more fractional
      // precision than the asset can represent (prevents silent
      // undercharging when a misconfigured route uses "0.0000001").
      const amountRaw = toSmallestUnit(amount, 6);

      const handler = async (req, res, next) => {
        const route =
          (typeof req.path === "string" && req.path) ||
          String(req.originalUrl || "").split("?")[0] ||
          "/";
        try {
          // ── Path 1: x402 credential ──
          // `payment-signature` is the v2 header; `x-payment` is the v1
          // alias. Trim to tolerate clients that helpfully add whitespace.
          const x402Raw = firstHeader(
            req.headers["payment-signature"] ?? req.headers["x-payment"],
          );
          const x402Sig =
            typeof x402Raw === "string" ? x402Raw.trim() : "";

          if (x402Sig.length > 0) {
            // Build the paymentRequirements object the facilitator needs to
            // validate the signature against. Same shape as the 402 challenge
            // accepts[0] entry — identical source of truth so they can't
            // drift.
            const resourceUrl = `${resolveBaseUrl(req)}${route}`;
            const paymentRequirements = buildAcceptsEntry({
              network: x402Config.network,
              amountRaw,
              asset: x402Asset,
              payTo: x402Config.payTo,
              resourceUrl,
              description,
              extra: x402Extra,
            });

            const verified = await x402Verify(x402Sig, x402Config.facilitatorUrl, {
              amount: amountRaw,
              payTo: x402Config.payTo,
              timeoutMs: x402Config.timeoutMs,
              paymentRequirements,
              cdpAuth: x402Config.cdpAuth,
              onVerify: onVerify
                ? (payload) => onVerify(payload, { route, amount })
                : null,
            });

            if (verified.valid) {
              console.log(
                `[PAY] x402 verified amount=${amount} network=${x402Config.network} route=${route}`,
              );

              // Settlement. Default is fire-and-forget (fast response at
              // the cost of a small verify-OK/settle-FAIL exposure
              // window). Routes that charge more than they're willing to
              // lose should opt into `waitForSettle: true`.
              const settlePromise = x402Settle(
                verified.payload,
                x402Config.facilitatorUrl,
                x402Config.timeoutMs,
                verified.paymentRequirements ?? paymentRequirements,
                x402Config.cdpAuth,
              );

              const logSettle = (result) => {
                // Mask the tx hash: public ecloud logs are visible on
                // the verify dashboard, and a full tx lets anyone
                // correlate calls to a specific payer wallet. The
                // PAYMENT-RESPONSE header still carries the unmasked
                // value to the payer themselves (x402 v2 spec §5.3).
                const tx = result?.txHash ? ` tx=${maskHex(result.txHash)}` : "";
                console.log(
                  `[PAY] x402 settled amount=${amount} route=${route}${tx}`,
                );
              };
              const logSettleFail = (err) => {
                console.error(
                  `[PAY] x402 settle FAILED amount=${amount} route=${route} err=${err.message}`,
                );
              };

              if (waitForSettle) {
                try {
                  const result = await settlePromise;
                  logSettle(result);
                  if (result?.txHash && !res.headersSent) {
                    res.setHeader(
                      "PAYMENT-RESPONSE",
                      base64Json({
                        success: true,
                        txHash: result.txHash,
                        network: x402Config.network,
                      }),
                    );
                  }
                } catch (err) {
                  logSettleFail(err);
                  // Settlement failure on a waitForSettle route must NOT
                  // let the request through — that's the whole point.
                  //
                  // Return 502 (Bad Gateway) rather than 402: the caller
                  // DID pay/authorize, we just couldn't complete the
                  // transfer. 402 would suggest "pay again" and many
                  // clients would auto-retry with the same authorization,
                  // which will likely fail the same way (or, worse, risk
                  // a double-charge if the first settlement actually
                  // landed and only the ack was lost). Surface the
                  // challenge on the side so a human debugger can still
                  // see what the route expected.
                  if (!res.headersSent) {
                    const resourceUrl = `${resolveBaseUrl(req)}${route}`;
                    try {
                      res.setHeader(
                        "PAYMENT-REQUIRED",
                        base64Json(
                          buildPaymentRequired({
                            network: x402Config.network,
                            amountRaw,
                            asset: x402Config.asset,
                            payTo: x402Config.payTo,
                            resourceUrl,
                            description,
                            extra: x402Config.extra,
                            inputSchema: handler._dualInputSchema,
                            outputSchema: handler._dualOutputSchema,
                            inputExample: handler._dualInputExample,
                            outputExample: handler._dualOutputExample,
                            method: handler._dualCanonicalMethod ?? req.method,
                          }),
                        ),
                      );
                    } catch {
                      // Non-fatal; the 502 body still carries the reason.
                    }
                  }
                  return res.status(502).json({
                    error: "payment_settle_failed",
                    reason: sanitizeLogValue(err.message, 200),
                  });
                }
              } else {
                settlePromise.then(logSettle).catch(logSettleFail);

                if (verified.txHash && !res.headersSent) {
                  res.setHeader(
                    "PAYMENT-RESPONSE",
                    base64Json({
                      success: true,
                      txHash: verified.txHash,
                      network: x402Config.network,
                    }),
                  );
                }
              }

              return next();
            }
            // Invalid credential → fall through to 402 challenge. Don't
            // short-circuit here: the client might intend MPP and an
            // invalid x402 header on the same request shouldn't block it.
            console.warn(
              `[dual402] x402 verify failed reason=${verified.reason ?? "unknown"} route=${route}`,
            );
          }

          // ── Paths 2 & 3: delegate to mppx, inject x402 on its 402 ──
          //
          // mppx either accepts a valid MPP credential (→ next()) or
          // generates a 402 challenge. We patch res.status so that when
          // mppx (or anything downstream) returns 402, we layer the x402
          // PAYMENT-REQUIRED header onto the same response. One 402, two
          // protocol challenges.
          const resourceUrl = `${resolveBaseUrl(req)}${route}`;

          const paymentRequired = buildPaymentRequired({
            network: x402Config.network,
            amountRaw,
            asset: x402Config.asset,
            payTo: x402Config.payTo,
            resourceUrl,
            description,
            extra: x402Config.extra,
            inputSchema: handler._dualInputSchema,
            outputSchema: handler._dualOutputSchema,
            inputExample: handler._dualInputExample,
            outputExample: handler._dualOutputExample,
            // Use the route's declared canonical method (from dualDiscovery),
            // not req.method — otherwise a discovery probe hitting GET /foo
            // on a POST-canonical route publishes an envelope claiming the
            // route is GET, and the Bazaar validator sends future probes
            // with the wrong shape.
            method: handler._dualCanonicalMethod ?? req.method,
          });

          patchStatusToInject402(res, paymentRequired);

          return mppCharge(req, res, (...args) => {
            // Only treat it as a successful MPP verification when mppx
            // invokes next() without an error. Express error-propagation
            // uses next(err) / next("route") — logging "verified" for
            // those would falsify audit trails.
            if (args.length === 0 || args[0] === undefined) {
              console.log(
                `[PAY] mpp verified amount=${amount} route=${route}`,
              );
            }
            next(...args);
          });
        } catch (err) {
          console.error(`[dual402] handler error route=${route}:`, err);
          next(err);
        }
      };

      // Stash metadata so dualDiscovery() can reflect on a handler without
      // re-plumbing options through server.js.
      handler._dualAmount = amount;
      handler._dualDescription = description;
      return handler;
    },
  };
}

// ── Startup validation ──────────────────────────────────────────────────

function assertConfig(config) {
  const missing = [];
  if (!config?.mpp?.secretKey)  missing.push("mpp.secretKey (env MPP_SECRET_KEY)");
  if (!config?.mpp?.currency)   missing.push("mpp.currency (env USDC_TEMPO)");
  if (!config?.mpp?.recipient)  missing.push("mpp.recipient (env MPP_RECIPIENT or RECIPIENT_WALLET)");
  if (!config?.x402?.payTo)     missing.push("x402.payTo (env X402_PAYEE_ADDRESS or RECIPIENT_WALLET)");
  if (!config?.x402?.network)   missing.push("x402.network (env X402_NETWORK)");
  if (!config?.x402?.facilitatorUrl)
    missing.push("x402.facilitatorUrl (env X402_FACILITATOR_URL)");

  if (missing.length) {
    throw new Error(
      `dual402: missing required config:\n  - ${missing.join("\n  - ")}\n` +
        `Create a .env from .env.example and populate these before booting.`,
    );
  }

  // Soft checks: warn on values that are present but don't look right.
  // We don't throw here — some testnets or future chains may use
  // non-EVM addresses — but a typo in a mainnet wallet would otherwise
  // silently route real funds to the wrong place.
  if (!EVM_ADDR_RE.test(config.x402.payTo)) {
    console.warn(
      `[dual402] x402.payTo "${config.x402.payTo}" doesn't look like an EVM address ` +
        `(expected 0x + 40 hex chars). Double-check X402_PAYEE_ADDRESS.`,
    );
  }
  if (!EVM_ADDR_RE.test(config.mpp.recipient)) {
    console.warn(
      `[dual402] mpp.recipient "${config.mpp.recipient}" doesn't look like an EVM address. ` +
        `Double-check MPP_RECIPIENT / RECIPIENT_WALLET.`,
    );
  }
}

const EVM_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

function resolveMppRealm(config) {
  const explicit = normalizeRealm(config?.mpp?.realm || process.env.MPP_REALM);
  if (explicit) return explicit;
  return normalizeRealm(process.env.BASE_URL);
}

function normalizeRealm(value) {
  if (!value || typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  try {
    return new URL(trimmed).host;
  } catch {}

  try {
    return new URL(`https://${trimmed}`).host;
  } catch {}

  return trimmed.replace(/^\/+|\/+$/g, "");
}

// ── x402 challenge builders ─────────────────────────────────────────────

/**
 * Single source of truth for a PaymentRequirements entry. Used by both
 * the per-request PAYMENT-REQUIRED header and the /.well-known/x402
 * discovery list so they can't drift.
 *
 * `extra` carries the EIP-3009 domain params (`name` + `version`) that
 * clients need to build a valid TransferWithAuthorization signature.
 * USDC on Base/Ethereum uses name="USD Coin", version="2" (the token's
 * `name()` getter — the EIP-712 domain separator uses that exact string,
 * so signatures built with "USDC" would not verify on-chain); other
 * tokens differ, so this is threaded through from X402Config.
 */
function buildAcceptsEntry({
  network,
  amountRaw,
  asset,
  payTo,
  resourceUrl,
  description,
  extra,
}) {
  const entry = {
    scheme: "exact",
    network,
    amount: amountRaw,
    asset,
    payTo,
    maxTimeoutSeconds: 300,
    extra: { ...extra },
  };
  if (resourceUrl) entry.resource = resourceUrl;
  if (description) entry.description = description;
  return entry;
}

function buildPaymentRequired({
  network,
  amountRaw,
  asset,
  payTo,
  resourceUrl,
  description,
  extra,
  inputSchema,
  outputSchema,
  inputExample,
  outputExample,
  method,
}) {
  const extensions = buildBazaarExtensions({
    method,
    inputSchema,
    outputSchema,
    inputExample,
    outputExample,
  });
  return {
    x402Version: 2,
    accepts: [
      buildAcceptsEntry({ network, amountRaw, asset, payTo, resourceUrl, description, extra }),
    ],
    // Top-level `resource` object is retained for backwards-compat with
    // clients that read it from the root instead of from the first accept.
    // Include `method` so clients that key off `resource.method` (e.g.
    // AgentCash auto-pay) know this is a POST/PUT/PATCH route and
    // should preserve the request body on the paid retry.
    resource: {
      url: resourceUrl,
      ...(typeof method === "string" &&
        method.length > 0 && { method: method.toUpperCase() }),
      description: description ?? "",
      mimeType: "application/json",
    },
    ...(extensions && { extensions }),
  };
}

// HTTP methods recognized by the x402 Bazaar discovery extension.
// Source: @x402/extensions@2.3.0 `DiscoveryInfo` union
// (QueryDiscoveryInfo for GET/HEAD/DELETE, BodyDiscoveryInfo for POST/PUT/PATCH).
const BAZAAR_QUERY_METHODS = ["GET", "HEAD", "DELETE"];
const BAZAAR_BODY_METHODS = ["POST", "PUT", "PATCH"];

/**
 * Build the `bazaar` discovery extension for a 402 challenge.
 *
 * Emits BOTH `info` and `schema` — per the x402 v2 Bazaar spec both
 * are required, and clients (AgentCash, @x402/extensions) validate
 * `info` against `schema` with Ajv before extracting discovery info.
 * If validation fails they silently drop the extension and may fall
 * back to sending no body on the paid retry, which we've seen surface
 * as 400s on POST routes. So we mirror @x402/extensions'
 * createQuery/BodyDiscoveryExtension shape exactly.
 *
 * @param {object} args
 * @param {string} args.method           HTTP verb (GET/POST/...).
 * @param {object} [args.inputSchema]    JSON Schema for the query params
 *                                        (GET/HEAD/DELETE) or JSON body
 *                                        (POST/PUT/PATCH).
 * @param {object} [args.outputSchema]   JSON Schema for the response body.
 *                                        Also used as `output.example` in
 *                                        info — schemas are fine there; the
 *                                        spec treats it as a hint, not a
 *                                        strictly-validated example value.
 */
function buildBazaarExtensions({
  method,
  inputSchema,
  outputSchema,
  inputExample,
  outputExample,
}) {
  const hasInput = inputSchema && typeof inputSchema === "object";
  const hasOutput = outputSchema && typeof outputSchema === "object";
  if (!hasInput && !hasOutput) return undefined;

  const upper = typeof method === "string" ? method.toUpperCase() : "";
  const isBodyMethod = BAZAAR_BODY_METHODS.includes(upper);
  const isQueryMethod = BAZAAR_QUERY_METHODS.includes(upper);

  // info.input: concrete example values. The Bazaar validator probes
  // candidate resources with the example shape declared here, so passing
  // a real example (matching the route's input schema) lets the validator
  // clear request-validation middleware and reach the payment layer. If
  // no example is provided, fall back to {} — the spec only requires the
  // field exists, but validators probing with {} won't clear routes that
  // validate before charging.
  const bodyExample =
    inputExample && typeof inputExample === "object" ? inputExample : {};
  const outExample =
    outputExample && typeof outputExample === "object" ? outputExample : {};
  const info = {
    input: {
      type: "http",
      ...(upper && { method: upper }),
      ...(isBodyMethod && { bodyType: "json", body: bodyExample }),
      ...(!isBodyMethod && hasInput && { queryParams: bodyExample }),
    },
    ...(hasOutput && { output: { type: "json", example: outExample } }),
  };

  // schema: JSON Schema that validates `info` above. Must reference the
  // concrete method enum (not the union) because AgentCash-side Ajv rejects
  // an info where info.input.method is outside the schema's enum list.
  const inputProperties = {
    type: { type: "string", const: "http" },
    ...(upper && {
      method: {
        type: "string",
        enum: isBodyMethod
          ? BAZAAR_BODY_METHODS
          : isQueryMethod
            ? BAZAAR_QUERY_METHODS
            : [upper],
      },
    }),
    ...(isBodyMethod && {
      bodyType: { type: "string", enum: ["json", "form-data", "text"] },
      body: hasInput ? inputSchema : { type: "object" },
    }),
    ...(!isBodyMethod &&
      hasInput && {
        queryParams: { type: "object", ...inputSchema },
      }),
  };
  const inputRequired = isBodyMethod
    ? ["type", "bodyType", "body"]
    : ["type"];

  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      input: {
        type: "object",
        properties: inputProperties,
        required: inputRequired,
        additionalProperties: false,
      },
      ...(hasOutput && {
        output: {
          type: "object",
          properties: {
            type: { type: "string" },
            example: { type: "object", ...outputSchema },
          },
          required: ["type"],
        },
      }),
    },
    required: ["input"],
  };

  return { bazaar: { info, schema } };
}

/**
 * Patch res.status so a 402 response (from mppx or anywhere downstream)
 * also carries the x402 PAYMENT-REQUIRED header. Scoped to THIS response
 * only; Node issues a fresh `res` per request so there's no cross-request
 * leak.
 */
function patchStatusToInject402(res, paymentRequired) {
  const origStatus = res.status.bind(res);
  res.status = (code) => {
    if (code === 402 && !res.headersSent) {
      // Best-effort. If header setting races with response finalization
      // (unlikely — status() is called before send() in Express), we
      // silently skip rather than crash the request.
      try {
        res.setHeader("PAYMENT-REQUIRED", base64Json(paymentRequired));
      } catch (err) {
        console.warn(`[dual402] could not attach PAYMENT-REQUIRED: ${err.message}`);
      }
    }
    return origStatus(code);
  };
}

// ── x402 facilitator HTTP calls ─────────────────────────────────────────
//
// Both calls are bounded by `timeoutMs`. Verification failures fail-closed
// (return valid:false); settlement failures throw so the caller can log
// the verify-OK / settle-FAIL mismatch loudly.

/**
 * Host used by Coinbase Developer Platform's hosted facilitator. JWT
 * Bearer auth is injected only when the URL we're calling matches this
 * host AND the caller passed `cdpAuth`. We intentionally check the parsed
 * host rather than substring-matching the full URL so a self-hosted
 * facilitator with "cdp" in its name can't accidentally have credentials
 * leaked to it.
 */
const CDP_FACILITATOR_HOST = "api.cdp.coinbase.com";

async function fetchJsonWithTimeout(url, body, timeoutMs, cdpAuth) {
  const headers = { "Content-Type": "application/json" };

  // Attach a CDP-minted JWT only when both the caller configured cdpAuth
  // AND the destination is a CDP host. Any other facilitator (x402.org,
  // self-hosted) keeps the legacy unauthenticated behavior.
  if (cdpAuth) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      parsed = null;
    }
    if (parsed && parsed.host === CDP_FACILITATOR_HOST) {
      try {
        const jwt = generateCdpJwt({
          apiKeyId: cdpAuth.apiKeyId,
          apiKeySecret: cdpAuth.apiKeySecret,
          requestMethod: "POST",
          requestHost: parsed.host,
          requestPath: parsed.pathname,
          expiresIn: 120,
        });
        headers["Authorization"] = `Bearer ${jwt}`;
      } catch (err) {
        // Don't silently send an unauthenticated request — the CDP call
        // will 401 anyway and the user needs to see WHY we couldn't mint
        // the token (bad PEM, wrong key format, etc.).
        throw new Error(`cdp_jwt_mint_failed: ${err.message}`);
      }
    }
  }

  return fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/**
 * Hard ceiling on the length of the base64 signature header we'll decode.
 * A real x402 payload is ~400–1200 bytes; 16 KiB leaves generous headroom
 * while bounding allocation cost for attackers that spray junk. Node's
 * default HTTP header budget (8 KiB/header, 80 KiB total) already caps
 * this, but we're belt-and-braces — this file may be copied into servers
 * with different limits.
 */
const MAX_SIGNATURE_BYTES = 16 * 1024;

/**
 * Decode the base64-encoded JSON payload in a payment signature header.
 * Returns `null` if the payload is oversize, unparseable, or is not a
 * plain object (e.g. `null`, an array, a primitive). Refusing non-objects
 * early keeps the caller's field accesses (`payload.amount`,
 * `payload.payTo`) safe.
 */
function decodePaymentPayload(paymentSignature) {
  try {
    const raw = String(paymentSignature);
    if (raw.length === 0 || raw.length > MAX_SIGNATURE_BYTES) return null;
    const json = Buffer.from(raw, "base64").toString("utf-8");
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

// Locate `amount` and `payee` inside a decoded x402 payment-signature
// envelope. Real x402 v2 clients (AgentCash, @x402/fetch, …) nest these
// under `payload.payload.authorization` (EIP-3009 `value` + `to`), but
// older/simpler clients also use flat `amount` / `payTo`. Traverse every
// shape we've seen in the wild; return `undefined` if nothing matches.
// Returning undefined is NOT by itself a rejection — the facilitator is
// the real source of truth. We only reject locally when we can extract
// the field AND it disagrees with what this route charges.
function extractPayloadAmount(p) {
  return p?.payload?.authorization?.value
      ?? p?.authorization?.value
      ?? p?.payload?.amount
      ?? p?.amount
      ?? p?.value;
}

function extractPayloadPayee(p) {
  return p?.payload?.authorization?.to
      ?? p?.authorization?.to
      ?? p?.payload?.payTo
      ?? p?.payTo
      ?? p?.to;
}

// Quick structural check: does this look like *any* x402 payment envelope?
// Real payloads always have at least one of these keys somewhere — signature
// (EIP-712 sig), authorization (EIP-3009 transfer auth), scheme, or a
// nested `payload` object. Missing all of them means the request is either
// a misconfigured client or a probe; reject locally to save a facilitator
// round-trip.
function looksLikeX402Envelope(p) {
  if (!p || typeof p !== "object") return false;
  if ("signature" in p || "authorization" in p || "scheme" in p) return true;
  if (p.payload && typeof p.payload === "object") {
    return "signature" in p.payload || "authorization" in p.payload;
  }
  return false;
}

/**
 * Per x402 v2 spec §5.1.2, a PaymentRequirements object has exactly these
 * fields:
 *   { scheme, network, amount, asset, payTo, maxTimeoutSeconds, extra? }
 *
 * Non-spec additions (e.g. `resource`, `description`) are useful in our
 * own 402 challenge response — clients read them for display — but strict
 * facilitator schema validators (CDP) reject them as "invalid_payload".
 *
 * This strips to the canonical set for anything going over the wire to a
 * facilitator. Our own client-facing 402 challenge keeps the extras.
 *
 * Safe to call on any shape; returns the input unchanged if it's not an
 * object.
 */
function canonicalizeRequirements(req) {
  if (!req || typeof req !== "object") return req;
  const out = {
    scheme: req.scheme,
    network: req.network,
    amount: req.amount,
    asset: req.asset,
    payTo: req.payTo,
    maxTimeoutSeconds: req.maxTimeoutSeconds,
  };
  if (req.extra && typeof req.extra === "object") out.extra = req.extra;
  return out;
}

/**
 * Reshape an incoming PaymentPayloadV2 for facilitator consumption.
 * Per spec §5.2.2 the required fields are {x402Version, accepted, payload}
 * and optional are {resource, extensions}. Clients (AgentCash, @x402/fetch)
 * send a spec-correct envelope; we just strip `accepted` to the canonical
 * PaymentRequirements shape since clients echo whatever extras we stuffed
 * into our own 402 challenge and CDP rejects extras as invalid.
 *
 * Do NOT alter `payload.payload` (the EIP-3009 authorization + signature)
 * or any other top-level field — only normalize `accepted`.
 */
function canonicalizePaymentPayload(payload) {
  if (!payload || typeof payload !== "object") return payload;
  if (!payload.accepted || typeof payload.accepted !== "object") return payload;
  return {
    ...payload,
    accepted: canonicalizeRequirements(payload.accepted),
  };
}

async function x402Verify(paymentSignature, facilitatorUrl, expected) {
  const { amount, payTo, timeoutMs, paymentRequirements, onVerify, cdpAuth } = expected;
  const payload = decodePaymentPayload(paymentSignature);
  if (!payload) return { valid: false, reason: "payload_malformed" };
  if (!looksLikeX402Envelope(payload)) {
    return { valid: false, reason: "envelope_unrecognized" };
  }

  // Best-effort local guard. Extract amount + payee from the envelope; if we
  // find them, reject immediately on mismatch (cheap defense-in-depth,
  // saves a facilitator round-trip). If we can't find them — because the
  // envelope is from a client shape we haven't seen — fall through to
  // facilitator verification instead of rejecting. The facilitator is the
  // authoritative validator; the local check is an optimization.
  const paymentAmount = extractPayloadAmount(payload);
  if (paymentAmount !== undefined && paymentAmount !== null) {
    if (!amountsEqual(paymentAmount, amount)) {
      console.warn(
        `[dual402] x402 amount mismatch got=${sanitizeLogValue(paymentAmount)} want=${amount}`,
      );
      return { valid: false, reason: "amount_mismatch" };
    }
  }

  const rawPayee = extractPayloadPayee(payload);
  if (rawPayee !== undefined && rawPayee !== null && rawPayee !== "") {
    const paymentPayee = String(rawPayee).toLowerCase();
    if (paymentPayee !== String(payTo).toLowerCase()) {
      // Mask both addresses — the `got` one is supplied by the client
      // (could identify a payer to an onlooker), and the `want` one,
      // while public on .well-known/x402, is unnecessary in every log
      // line. Six chars of prefix + four of suffix is enough to
      // diff them at a glance.
      console.warn(
        `[dual402] x402 payee mismatch got=${maskHex(paymentPayee)} want=${maskHex(payTo)}`,
      );
      return { valid: false, reason: "payee_mismatch" };
    }
  }

  // Optional application hook (replay cache, rate limits, etc.).
  if (onVerify) {
    try {
      const hookResult = await onVerify(payload);
      if (hookResult === false) {
        return { valid: false, reason: "rejected_by_hook" };
      }
    } catch (err) {
      console.warn(`[dual402] onVerify hook threw: ${err.message}`);
      return { valid: false, reason: "hook_error" };
    }
  }

  // Strip the paymentPayload's echoed `accepted` AND our own outgoing
  // paymentRequirements to the strict x402 v2 spec shape (§5.1.2). CDP's
  // schema validator rejects non-spec fields with a generic
  // "invalid_payload" reason.
  const wirePayload = canonicalizePaymentPayload(payload);
  const wireRequirements = canonicalizeRequirements(paymentRequirements);

  try {
    // x402 v2 facilitator request body per the CDP & community spec:
    //   { x402Version, paymentPayload, paymentRequirements }
    // CDP returns 401 on a malformed body; x402.org accepts either shape
    // but prefers this one too. If the caller didn't hand us paymentRequirements
    // (legacy code path, e.g. custom onVerify wiring), fall back to the
    // old `{ payload }` body so we don't break downstream integrations.
    const body = paymentRequirements
      ? {
          x402Version: 2,
          paymentPayload: wirePayload,
          paymentRequirements: wireRequirements,
        }
      : { payload };

    const res = await fetchJsonWithTimeout(
      `${facilitatorUrl}/verify`,
      body,
      timeoutMs,
      cdpAuth,
    );

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // Field-by-field diagnostics. Facilitators often collapse semantic
      // failures into a single generic reason (e.g. CDP's "invalid_payload");
      // this surfaces WHICH invariant was violated so you don't burn
      // deploy cycles guessing. No secrets — just booleans and addresses
      // you already put in the 402 challenge.
      const auth = wirePayload?.payload?.authorization ?? {};
      const acc = wirePayload?.accepted ?? {};
      const req = wireRequirements ?? {};
      const now = Math.floor(Date.now() / 1000);
      const diag = {
        amt_match: req.amount === acc.amount,
        payto_match: String(req.payTo).toLowerCase() === String(acc.payTo).toLowerCase(),
        asset_match: String(req.asset).toLowerCase() === String(acc.asset).toLowerCase(),
        net_match: req.network === acc.network,
        auth_val_match: auth.value === req.amount,
        auth_to_match: String(auth.to ?? "").toLowerCase() === String(req.payTo).toLowerCase(),
        // Self-transfer (from==to) causes facilitator simulation to fail
        // without a useful error; surface it explicitly since it's a
        // common misconfig (client wallet == payee wallet).
        self_transfer:
          String(auth.from ?? "").toLowerCase() === String(auth.to ?? "").toLowerCase(),
        nonce_len: String(auth.nonce ?? "").length,
        time_window_ok:
          auth.validAfter && auth.validBefore
            ? Number(auth.validAfter) <= now && now <= Number(auth.validBefore)
            : "n/a",
      };
      console.warn(
        `[dual402] facilitator /verify status=${res.status} ` +
          `body=${sanitizeLogValue(text, 400)} ` +
          `diag=${JSON.stringify(diag)}`,
      );
      return { valid: false, reason: `facilitator_${res.status}` };
    }

    const data = await res.json().catch(() => null);
    if (!data || typeof data !== "object") {
      return { valid: false, reason: "facilitator_bad_json" };
    }
    // Response shape (per CDP + x402 spec): { isValid, invalidReason?, payer? }.
    // Legacy facilitators may use { valid, reason, txHash } — accept both.
    // Only propagate fields we trust; coerce `reason` to a short safe string.
    const valid = data.isValid === true || data.valid === true;
    const rawReason =
      typeof data.invalidReason === "string"
        ? data.invalidReason
        : typeof data.reason === "string"
          ? data.reason
          : null;
    return {
      valid,
      reason: valid
        ? undefined
        : rawReason
          ? sanitizeLogValue(rawReason, 80)
          : "facilitator_rejected",
      txHash: typeof data.txHash === "string" ? data.txHash : undefined,
      // Return the canonical shapes so x402Settle uses the same
      // CDP-compatible bodies without re-normalizing.
      payload: valid ? wirePayload : undefined,
      paymentRequirements: valid ? wireRequirements : undefined,
    };
  } catch (err) {
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      console.error(
        `[dual402] facilitator /verify TIMEOUT after ${timeoutMs}ms`,
      );
      return { valid: false, reason: "facilitator_timeout" };
    }
    console.error(`[dual402] facilitator /verify error: ${err.message}`);
    return { valid: false, reason: "verify_error" };
  }
}

/**
 * Settle a previously-verified payment with the facilitator.
 * Takes the already-decoded payload + paymentRequirements returned by
 * x402Verify so we don't base64-decode + JSON-parse the same signature
 * twice on the happy path, and we send the facilitator the same bound
 * requirements it saw on verify.
 */
async function x402Settle(payload, facilitatorUrl, timeoutMs, paymentRequirements, cdpAuth) {
  if (!payload || typeof payload !== "object") {
    throw new Error("x402Settle: payload must be the decoded object from x402Verify");
  }

  // Idempotent — if x402Verify already canonicalized, these are no-ops.
  // Defense-in-depth for any future caller who invokes settle without verify.
  const wirePayload = canonicalizePaymentPayload(payload);
  const wireRequirements = canonicalizeRequirements(paymentRequirements);

  const body = paymentRequirements
    ? {
        x402Version: 2,
        paymentPayload: wirePayload,
        paymentRequirements: wireRequirements,
      }
    : { payload };

  const res = await fetchJsonWithTimeout(
    `${facilitatorUrl}/settle`,
    body,
    timeoutMs,
    cdpAuth,
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`facilitator /settle ${res.status}: ${text.slice(0, 200)}`);
  }

  // CDP response shape: { success, transaction, network, payer }.
  // Legacy: { txHash }. Normalize to { txHash } for callers.
  const data = await res.json().catch(() => ({}));
  return {
    ...data,
    txHash:
      typeof data.transaction === "string"
        ? data.transaction
        : typeof data.txHash === "string"
          ? data.txHash
          : undefined,
  };
}

// ── Discovery (mounts /openapi.json and /.well-known/x402) ─────────────

/**
 * Build and mount:
 *   - GET /openapi.json       AgentCash-compliant OpenAPI 3.1.0
 *   - GET /.well-known/x402   x402 v1 fallback discovery
 *
 * Reads `_dualAmount` / `_dualDescription` off each route's charge handler
 * to populate pricing — no need to re-specify amounts in two places.
 *
 * @param {import('express').Express} app
 * @param {ReturnType<typeof createDual402>} dual
 * @param {{
 *   info: { title: string, version: string, description: string, "x-guidance"?: string },
 *   serviceInfo?: object,
 *   ownershipProofs?: object[],
 *   routes: Array<{
 *     method: string, path: string, handler: Function,
 *     operationId: string, summary: string, description?: string,
 *     tags?: string[], parameters?: object[],
 *     requestBodySchema?: object, requestBodyRequired?: boolean,
 *     responseSchema?: object,
 *   }>
 * }} config
 */
export function dualDiscovery(app, dual, config) {
  const paths = {};

  for (const r of config.routes) {
    if (typeof r.handler?._dualAmount !== "string") {
      throw new Error(
        `dualDiscovery: route ${r.method.toUpperCase()} ${r.path} is missing a dual402 charge handler. ` +
          `Use dual.charge({...}) to wrap the route.`,
      );
    }

    // Stash the route's declared canonical method so the 402 envelope's
    // bazaar info.input.method reflects the intended invocation shape,
    // not the incidental method of whatever probe triggered the 402.
    // When one handler is shared between GET and POST mounts, the last
    // `method` declared in config.routes wins — declare POST (canonical).
    if (!r.handler._dualCanonicalMethod) {
      r.handler._dualCanonicalMethod = r.method.toUpperCase();
    }

    const amount = r.handler._dualAmount;

    const operation = {
      operationId: r.operationId,
      summary: r.summary,
      ...(r.description && { description: r.description }),
      tags: r.tags ?? [],
      "x-payment-info": {
        price: {
          mode: "fixed",
          currency: "USD",
          amount,
        },
        protocols: [
          {
            x402: {},
          },
          {
            mpp: {
              method: "tempo",
              intent: "charge",
              currency: "USDC",
            },
          },
        ],
      },
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: r.responseSchema ?? {
                type: "object",
                properties: {
                  results: { type: "array", items: { type: "object" } },
                },
                required: ["results"],
              },
            },
          },
        },
        402: { description: "Payment Required" },
      },
    };

    if (r.parameters?.length) operation.parameters = r.parameters;
    if (r.requestBodySchema) {
      operation.requestBody = {
        required: r.requestBodyRequired ?? true,
        content: {
          "application/json": {
            schema: r.requestBodySchema,
          },
        },
      };
    }

    paths[r.path] = {
      ...(paths[r.path] ?? {}),
      [r.method]: operation,
    };
  }

  const spec = {
    openapi: "3.1.0",
    info: {
      title: config.info.title,
      version: config.info.version,
      description: config.info.description,
      ...(config.info["x-guidance"] && { "x-guidance": config.info["x-guidance"] }),
    },
    "x-discovery": { ownershipProofs: config.ownershipProofs ?? [] },
    paths,
  };

  if (config.serviceInfo) spec["x-service-info"] = config.serviceInfo;

  app.get("/openapi.json", (req, res) =>
    res.json({
      ...spec,
      servers: [{ url: resolveBaseUrl(req) }],
    }),
  );

  // /.well-known/x402 — minimal v1 fallback discovery.
  app.get("/.well-known/x402", (req, res) => {
    const resources = Array.from(
      new Set(config.routes.map((r) => `${r.method.toUpperCase()} ${r.path}`)),
    );
    res.json({ version: 1, resources });
  });
}

// ── Utilities ───────────────────────────────────────────────────────────

/**
 * Convert a decimal-string amount to smallest-unit integer string, doing
 * the math with strings to avoid binary-float error at sub-cent scales.
 *
 *   toSmallestUnit("0.02", 6)      === "20000"
 *   toSmallestUnit("1.234567", 6)  === "1234567"
 *   toSmallestUnit("0.000001", 6)  === "1"
 *
 * Throws if the input has more fractional digits than the asset can
 * represent AND those extra digits are non-zero — silently truncating
 * would cause an undercharge (e.g. "0.0000001" → "0" at 6 decimals would
 * make a route free without warning).
 */
function toSmallestUnit(amountStr, decimals) {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(amountStr).trim());
  if (!m) throw new Error(`toSmallestUnit: invalid amount ${JSON.stringify(amountStr)}`);
  const whole = m[1];
  const fracFull = m[2] ?? "";
  if (fracFull.length > decimals && /[1-9]/.test(fracFull.slice(decimals))) {
    throw new Error(
      `toSmallestUnit: amount "${amountStr}" has more precision than the asset ` +
        `(${decimals} decimals) can represent. Truncating would undercharge.`,
    );
  }
  const frac = fracFull.padEnd(decimals, "0").slice(0, decimals);
  // Strip leading zeros; "0" if the result is empty.
  const combined = (whole + frac).replace(/^0+/, "") || "0";
  return combined;
}

function base64Json(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64");
}

/**
 * Sanitize a value for inclusion in a structured log line. Strips ASCII
 * control characters (newlines, carriage returns, NULs, ANSI escapes)
 * that a hostile client could embed in payment payload fields to forge
 * or corrupt log entries, then truncates to `max` chars. The output is
 * meant to be human-readable in `key=value` log lines, not machine-
 * parseable — downstream pipelines should still escape/quote as needed.
 */
function sanitizeLogValue(v, max = 64) {
  return String(v ?? "")
    .replace(/[\x00-\x1f\x7f]/g, "?")
    .slice(0, max);
}

/**
 * Mask a hex identifier (EVM address, tx hash, nonce) in logs so public
 * log streams don't leak payer attribution. Keeps the `0x` prefix, the
 * first `head` chars after it, and the last `tail` chars — enough to
 * correlate the same identifier across adjacent log lines in a single
 * request, but not enough to cross-reference to a block explorer.
 *
 * Ecloud runs us with `--log-visibility public`, so `[PAY] x402 settled
 * ... tx=0x…` entries were being surfaced in the verify.eigencloud.xyz
 * dashboard. Any onlooker could cross the tx hash with Base and recover
 * the payer address, amount, and timing — effectively a public ledger
 * of who queries which routes when. We still emit the header
 * PAYMENT-RESPONSE to the paying client (spec §5.3 makes `transaction`
 * a required field); this helper only applies to log lines.
 *
 * Non-hex input is returned lightly trimmed via sanitizeLogValue so
 * callers don't have to special-case undefined / "" / garbage inputs.
 */
export function maskHex(v, { head = 6, tail = 4 } = {}) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  // Accept both `0x…` (EVM) and bare hex. Must be ≥ head+tail+3 chars
  // to be worth masking; otherwise just pass through sanitized so
  // callers don't see "0x…" for a legitimately short value.
  const hex = /^0x[0-9a-fA-F]+$/.test(s)
    ? { prefix: "0x", body: s.slice(2) }
    : /^[0-9a-fA-F]+$/.test(s)
      ? { prefix: "", body: s }
      : null;
  if (!hex) return sanitizeLogValue(s, 32);
  if (hex.body.length <= head + tail) return `${hex.prefix}${hex.body}`;
  return `${hex.prefix}${hex.body.slice(0, head)}…${hex.body.slice(-tail)}`;
}

/**
 * Normalize a header value to a single string. Node occasionally hands us
 * `string[]` for headers seen multiple times (e.g. Set-Cookie semantics);
 * for a payment signature we take the first and ignore the rest.
 */
function firstHeader(v) {
  if (Array.isArray(v)) return v[0];
  return v;
}

/**
 * Resolve the base URL that should be advertised to clients in payment
 * challenges and discovery documents.
 *
 * Priority:
 *   1. `process.env.BASE_URL` — explicit override (trailing slash trimmed).
 *   2. `${req.protocol}://${req.get("host")}` — honors X-Forwarded-Proto
 *      and X-Forwarded-Host when Express `trust proxy` is enabled.
 *
 * We deliberately never use `os.hostname()` or interface enumeration,
 * which would expose internal infrastructure addresses to the public.
 *
 * If neither BASE_URL is set nor a Host header is present, returns an
 * empty string so the resource URL degrades to a bare path rather than
 * `http://undefined/...`. This shouldn't happen under Express in
 * practice — Host is required by HTTP/1.1 — but we don't want to leak
 * a broken URL if it ever does.
 */
let warnedMissingHost = false;
function resolveBaseUrl(req) {
  const override = process.env.BASE_URL;
  if (override && override.length > 0) {
    return override.replace(/\/+$/, "");
  }
  const host = req.get("host");
  if (!host) {
    if (!warnedMissingHost) {
      console.warn(
        "[dual402] request has no Host header; resource URLs will be relative. " +
          "Set BASE_URL to suppress this warning.",
      );
      warnedMissingHost = true;
    }
    return "";
  }
  return `${req.protocol}://${host}`;
}

/**
 * Compare two amounts in smallest-unit representation. Accepts either
 * strings or numbers on either side, converts to BigInt, and returns
 * strict equality. Malformed values (non-integer strings, NaN, scientific
 * notation that isn't a safe integer, etc.) return false rather than
 * throwing — the caller treats "unparseable" the same as "mismatched".
 */
function amountsEqual(a, b) {
  try {
    return toBigIntStrict(a) === toBigIntStrict(b);
  } catch {
    return false;
  }
}

function toBigIntStrict(v) {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v) || v < 0) {
      throw new Error(`not a safe non-negative integer: ${v}`);
    }
    return BigInt(v);
  }
  if (typeof v === "string") {
    // BigInt("20000") → 20000n; BigInt("20000.0") throws. That's the
    // behavior we want — smallest-unit amounts are always integers.
    return BigInt(v);
  }
  throw new Error(`cannot coerce to BigInt: ${typeof v}`);
}
