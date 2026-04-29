# hive-subscription

Recurring x402 subscription primitive for agent-to-agent commerce.

[![Hive Civilization](https://img.shields.io/badge/Hive%20Civilization-x402-C08D23?style=flat-square&labelColor=1a1a1a)](https://github.com/srotzin/hive-subscription)
[![MCP 2024-11-05](https://img.shields.io/badge/MCP-2024--11--05-C08D23?style=flat-square&labelColor=1a1a1a)](https://github.com/srotzin/hive-subscription)
[![License: MIT](https://img.shields.io/badge/License-MIT-C08D23?style=flat-square&labelColor=1a1a1a)](./LICENSE)

---

## Why this exists — three gates

### NEED
x402 is single-shot today. No recurring billing primitive exists for agent-to-agent commerce. Visa's recurring-card rails require merchant accounts, MCC codes, and chargeback reserves — none of which apply to agent flows. Agents that want to subscribe to a service have no standard mechanism. This fills that gap.

### YIELD
Renewal fee: 2% of `amount_atomic` + $0.005 flat per period. Hive take: 2% (15% of total fee, balance to merchant treasury). Free tier: 1 subscription per DID, $0 merchant volume cap. At 100K agents subscribing at $5/mo avg: $500K MRR × 2% = **$330/d** initial. Compounds with every SaaS-shaped agent flow that cannot exist on Visa rails.

### CLEAN-MONEY
Settlement in USDC on Base (chain ID 8453). Pay-to address: Monroe treasury `0x15184bf50b3d3f52b60434f8942b7d52f2eb436e`. No custodied funds — payer controls their wallet at all times. No energy futures, GAS-PERP, or GPU-PERP. No simulated or testnet rails.

---

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | none | Service health, Monroe address, hive_take_pct |
| GET | `/.well-known/agent.json` | none | DID-style agent card with Monroe, Spectral pubkey, capabilities |
| GET | `/.well-known/jwks.json` | none | JWKS for ed25519 public key |
| GET | `/.well-known/mcp.json` | none | MCP manifest |
| POST | `/mcp` | none | MCP JSON-RPC 2.0 (tools/list + tools/call) |
| POST | `/v1/subscription/create` | none | Create subscription, returns signed contract |
| POST | `/v1/subscription/renew` | x402 | Charge renewal fee, return Spectral-signed receipt |
| POST | `/v1/subscription/pause` | none | Pause by payer or merchant DID |
| POST | `/v1/subscription/resume` | none | Resume by payer or merchant DID |
| POST | `/v1/subscription/cancel` | none | Cancel by payer or merchant DID |
| GET | `/v1/subscription/list?did=X` | none | List subscriptions for a DID |
| GET | `/v1/subscription/:id` | none | Get single subscription state |

---

## MCP Tools

| Tool | Description |
|------|-------------|
| `create_subscription` | Create a recurring x402 subscription between payer and merchant DIDs. Returns `subscription_id` and ed25519-signed renewal contract. |
| `renew_subscription` | Renew for the current period. x402 gated — 2% of amount + $0.005 flat. Idempotent on `(subscription_id, period_index)`. |
| `manage_subscription` | Pause, resume, or cancel. Both payer and merchant DIDs authorized. |
| `list_subscriptions` | List all subscriptions for a DID (as payer or merchant). Filter by `status`. |

---

## Subscription object

```json
{
  "id": "sub_<hex>",
  "payer_did": "did:web:agent.example.com",
  "merchant_did": "did:web:merchant.example.com",
  "amount_atomic": 5000000,
  "currency": "USDC",
  "chain": "base",
  "period_seconds": 2592000,
  "period_index": 0,
  "status": "active",
  "created_at": "2026-01-01T00:00:00.000Z",
  "signed_contract": { "...": "ed25519-signed renewal contract" },
  "last_renewed_at": null,
  "next_renewal_at": "2026-01-31T00:00:00.000Z"
}
```

---

## Pricing

| Item | Rate |
|------|------|
| Renewal fee | 2% of `amount_atomic` + $0.005 flat |
| Hive take | 2% of renewal fee (15% of total fee) |
| Free tier | 1 subscription per DID, $0 merchant volume cap |

All amounts in USDC on Base (6 decimal micro-units). Pay-to: Monroe treasury `0x15184bf50b3d3f52b60434f8942b7d52f2eb436e`.

---

## Spectral signing

Every subscription contract is ed25519-signed at `create`. Every renewal receipt is ed25519-signed at `renew`. The Spectral public key is published at `/.well-known/agent.json` → `spectral.public_key` (base64 SPKI) and as a JWKS at `/.well-known/jwks.json`. Keypair is generated at first boot and persisted to `data/spectral.key` (or supplied via `SPECTRAL_PRIVKEY_B64` / `SPECTRAL_PUBKEY_B64` env vars).

---

## x402 challenge format

On unauthenticated POST `/v1/subscription/renew`, the server returns:

```
HTTP/1.1 402 Payment Required
Content-Type: application/json
X-Payment-Required: true

{
  "x402_version": "0.2.0",
  "error": "Payment Required",
  "accepts": [{
    "scheme": "exact",
    "network": "base",
    "chainId": 8453,
    "asset": "USDC",
    "contract": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "maxAmountRequired": "<renewal_fee_atomic>",
    "payTo": "0x15184bf50b3d3f52b60434f8942b7d52f2eb436e",
    "resource": "/v1/subscription/renew",
    "description": "Renew subscription <id> — period <n>."
  }]
}
```

---

## Connect

**MCP endpoint:** `POST https://hive-subscription.onrender.com/mcp`

**Smithery:** [smithery.ai/new?repo=srotzin/hive-subscription](https://smithery.ai/new?repo=srotzin/hive-subscription)

---

## Storage

File-based JSON in `/opt/render/project/data` on Render (or `./data` locally). Subscription objects in `subscriptions.json`. Renewal idempotency keys in `renewals.json`. Spectral keypair in `spectral.key`.

---

## Council provenance

Ad-hoc — NEED + YIELD + CLEAN-MONEY documented above. Settlement in USDC on Base mainnet. No energy futures, GAS-PERP, GPU-PERP. No external markets layer.

---

## Run locally

```bash
git clone https://github.com/srotzin/hive-subscription
cd hive-subscription
npm install
node server.js
# → hive-subscription listening on :3000
curl http://localhost:3000/health
```

---

*Hive Civilization · Brand gold [#C08D23](https://github.com/srotzin/hive-subscription) · Part of the Hive MCP fleet*
