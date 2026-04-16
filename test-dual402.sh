#!/bin/bash
#
# test-dual402.sh — Test the dual x402 + MPP middleware locally.
#
# Usage:
#   ./test-dual402.sh                          # Test 1 only (no wallet needed)
#   ./test-dual402.sh --mpp                    # Tests 1 + 2 (auto-funded testnet wallet)
#   ./test-dual402.sh --x402 0xPRIVATE_KEY     # Tests 1 + 3 (needs Base Sepolia USDC)
#   ./test-dual402.sh --all 0xPRIVATE_KEY      # All tests
#
# Get free Base Sepolia USDC: https://faucet.circle.com (select Base Sepolia)

set -euo pipefail

REPO="/Users/matt/citibike-api"
cd "$REPO"

ENDPOINT="http://localhost:8080/citibike/nearest?lat=40.7128&lng=-74.0060"
SERVER_PID=""
PASS=0
FAIL=0
SKIP=0

cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

pass() { echo "  ✓ $1"; PASS=$((PASS+1)); }
fail() { echo "  ✗ $1"; FAIL=$((FAIL+1)); }
skip() { echo "  ⊘ $1"; SKIP=$((SKIP+1)); }

# ── Parse args ──────────────────────────────────────────────────────────

RUN_MPP=false
RUN_X402=false
X402_KEY=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mpp)     RUN_MPP=true; shift ;;
    --x402)    RUN_X402=true; X402_KEY="${2:-}"; shift 2 ;;
    --all)     RUN_MPP=true; RUN_X402=true; X402_KEY="${2:-}"; shift 2 ;;
    *)         echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# ── Ensure correct branch ──────────────────────────────────────────────

BRANCH=$(git branch --show-current)
if [ "$BRANCH" != "feat/dual-402" ]; then
  echo "Switching to feat/dual-402..."
  git checkout feat/dual-402
fi

# ── Start server ────────────────────────────────────────────────────────

echo ""
echo "Starting server..."
lsof -ti:8080 | xargs kill 2>/dev/null || true
sleep 1

ENV_FILE="$REPO/.env.test"
if [ ! -f "$ENV_FILE" ]; then
  ENV_FILE="$REPO/.env"
fi
echo "Using env: $ENV_FILE"
node --env-file="$ENV_FILE" "$REPO/server.js" &
SERVER_PID=$!
sleep 3

if ! kill -0 "$SERVER_PID" 2>/dev/null; then
  echo "ERROR: Server failed to start"; exit 1
fi
echo "Server running (PID $SERVER_PID)"
echo ""

# ── Test 1: Both 402 challenge headers ──────────────────────────────────

echo "━━━ Test 1: 402 challenge headers ━━━"
echo ""

HEADERS=$(curl -s -D - -o /tmp/dual402-body.json "$ENDPOINT" 2>&1)

if echo "$HEADERS" | grep -qi "www-authenticate:.*Payment"; then
  pass "MPP → WWW-Authenticate: Payment header present"
else
  fail "MPP → WWW-Authenticate header MISSING"
fi

if echo "$HEADERS" | grep -qi "payment-required:"; then
  pass "x402 → PAYMENT-REQUIRED header present"
else
  fail "x402 → PAYMENT-REQUIRED header MISSING"
fi

# Verify x402 payload decodes correctly
X402_DECODED=$(echo "$HEADERS" | grep -i "payment-required:" | sed 's/.*: //' | tr -d '\r' | base64 -d 2>/dev/null || echo "")
if echo "$X402_DECODED" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['x402Version']==2; assert d['accepts'][0]['network']=='eip155:84532'" 2>/dev/null; then
  pass "x402 payload: valid v2, network=eip155:84532"
else
  fail "x402 payload: decode or validation failed"
fi

# Verify CORS exposes both protocol headers
if echo "$HEADERS" | grep -qi "access-control-expose-headers:.*PAYMENT-REQUIRED"; then
  pass "CORS exposes PAYMENT-REQUIRED"
else
  fail "CORS does not expose PAYMENT-REQUIRED"
fi

# Verify discovery endpoints
echo ""
echo "━━━ Discovery ━━━"
echo ""

X402_DISC=$(curl -s "http://localhost:8080/.well-known/x402")
if echo "$X402_DISC" | python3 -c "import sys,json; d=json.load(sys.stdin); assert len(d['resources'])==4" 2>/dev/null; then
  pass "/.well-known/x402 → 4 resources listed"
else
  fail "/.well-known/x402 → unexpected response"
fi

OA_DISC=$(curl -s "http://localhost:8080/openapi.json")
if echo "$OA_DISC" | python3 -c "import sys,json; d=json.load(sys.stdin); assert len(d['paths'])==4" 2>/dev/null; then
  pass "/openapi.json → 4 routes listed"
else
  fail "/openapi.json → unexpected response"
fi

echo ""
echo "━━━ AgentCash Discovery Validation ━━━"
echo ""

DISC_OUTPUT=$(npx -y @agentcash/discovery@latest discover "http://localhost:8080" 2>&1)
DISC_WARNINGS=$(echo "$DISC_OUTPUT" | grep -c "^\s*\[warn\]" || true)
DISC_ROUTES=$(echo "$DISC_OUTPUT" | grep -c "paid" || true)

echo "$DISC_OUTPUT" | sed 's/^/    /'
echo ""

if [ "$DISC_ROUTES" -eq 4 ]; then
  pass "AgentCash discover → 4 paid routes found"
else
  fail "AgentCash discover → expected 4 paid routes, got $DISC_ROUTES"
fi

if [ "$DISC_WARNINGS" -eq 0 ]; then
  pass "AgentCash discover → 0 warnings"
else
  fail "AgentCash discover → $DISC_WARNINGS warnings"
fi

# ── Test 2: MPP payment ────────────────────────────────────────────────

echo ""
echo "━━━ Test 2: MPP payment (mppx) ━━━"
echo ""

if [ "$RUN_MPP" = true ]; then
  # Use npx so no global install needed
  if npx --yes mppx account create 2>/dev/null; then
    pass "mppx account created (testnet auto-funded)"
  else
    skip "mppx account create failed (may already exist)"
  fi

  echo "  Sending MPP payment to $ENDPOINT ..."
  MPP_RESULT=$(npx --yes mppx "$ENDPOINT" 2>&1) && {
    pass "MPP payment succeeded"
    echo "$MPP_RESULT" | python3 -m json.tool 2>/dev/null | head -15 | sed 's/^/    /'
  } || {
    fail "MPP payment failed"
    echo "$MPP_RESULT" | head -5 | sed 's/^/    /'
  }
else
  skip "MPP payment (run with --mpp)"
fi

# ── Test 3: x402 payment ───────────────────────────────────────────────

echo ""
echo "━━━ Test 3: x402 payment (Base Sepolia) ━━━"
echo ""

if [ "$RUN_X402" = true ] && [ -n "$X402_KEY" ]; then
  # Install x402 client deps if missing
  if [ ! -d "$REPO/node_modules/@x402" ]; then
    echo "  Installing @x402/fetch and @x402/evm..."
    npm i --save-dev @x402/fetch @x402/evm 2>&1 | tail -1 | sed 's/^/    /'
  fi

  echo "  Sending x402 payment on Base Sepolia..."
  X402_RESULT=$(X402_PRIVATE_KEY="$X402_KEY" node "$REPO/test-x402.mjs" 2>&1) && {
    pass "x402 payment succeeded"
    echo "$X402_RESULT" | head -10 | sed 's/^/    /'
  } || {
    fail "x402 payment failed"
    echo "$X402_RESULT" | head -10 | sed 's/^/    /'
  }
elif [ "$RUN_X402" = true ] && [ -z "$X402_KEY" ]; then
  fail "x402 flag set but no private key provided (--x402 0xKEY)"
else
  skip "x402 payment (run with --x402 0xKEY)"
  echo "    Get free Base Sepolia USDC: https://faucet.circle.com"
fi

# ── Summary ─────────────────────────────────────────────────────────────

echo ""
echo "━━━ Results ━━━"
echo ""
echo "  $PASS passed, $FAIL failed, $SKIP skipped"
echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "  All checks passed."
else
  echo "  ⚠ Some checks failed."
fi
echo ""
