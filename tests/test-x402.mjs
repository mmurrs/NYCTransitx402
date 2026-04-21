/**
 * Quick x402 client test against local server.
 *
 * Prerequisites:
 *   npm i -g @x402/fetch @x402/evm
 *   Base Sepolia USDC in your wallet
 *   Get testnet USDC: https://faucet.circle.com (Base Sepolia)
 *
 * Usage:
 *   X402_PRIVATE_KEY=0x... node tests/test-x402.mjs
 */

import { wrapFetchWithX402 } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";

const privateKey = process.env.X402_PRIVATE_KEY;
if (!privateKey) {
  console.error("Set X402_PRIVATE_KEY env var (Base Sepolia wallet with USDC)");
  console.error("Get testnet USDC at: https://faucet.circle.com");
  process.exit(1);
}

const fetchWithX402 = wrapFetchWithX402(fetch, {
  schemes: [new ExactEvmScheme({ privateKey })],
});

const url =
  "http://localhost:8080/citibike/nearest?lat=40.7128&lng=-74.0060";

console.log(`Fetching ${url} with x402 payment...\n`);

const res = await fetchWithX402(url);
const body = await res.json();

console.log("Status:", res.status);
console.log("PAYMENT-RESPONSE:", res.headers.get("payment-response") ?? "none");
console.log("Result:", JSON.stringify(body, null, 2));
