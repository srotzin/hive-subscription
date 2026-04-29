# v1.0.0 — Hive Subscription MCP Server

Recurring x402 subscription primitive. Leapfrogs Visa's recurring-card moat.

## What it is

`hive-subscription` introduces the first recurring billing primitive for agent-to-agent x402 commerce. Where x402 is currently single-shot, this server adds a full subscription lifecycle: create, renew, pause, resume, cancel. Every contract is ed25519-signed by the Spectral keypair. Every renewal is idempotent on `(subscription_id, period_index)`.

## Tools

| Tool | Description |
|------|-------------|
| `create_subscription` | Create a recurring x402 subscription. Returns subscription_id and Spectral-signed contract. |
| `renew_subscription` | Renew for current period (x402 gated — 2% + $0.005 flat). Idempotent. |
| `manage_subscription` | Pause, resume, or cancel. Payer or merchant DID authorized. |
| `list_subscriptions` | List subscriptions for a DID. Filter by status. |

## Backend endpoint

`https://hive-subscription.onrender.com`

MCP endpoint: `POST https://hive-subscription.onrender.com/mcp`

## Pricing

- Renewal fee: 2% of `amount_atomic` + $0.005 flat per period
- Hive take: 2% (15% of total fee, balance to merchant)
- Free tier: 1 subscription per DID

## Council provenance

Ad-hoc — NEED + YIELD + CLEAN-MONEY gates passed. Settlement in USDC on Base mainnet (chain ID 8453). Monroe treasury: `0x15184bf50b3d3f52b60434f8942b7d52f2eb436e`. No energy futures, GAS-PERP, GPU-PERP. No testnet rails.

## Spectral signing

Keypair generated at first boot, persisted to `data/spectral.key`. Public key published at `/.well-known/agent.json` and as JWKS at `/.well-known/jwks.json`.

---

*Hive Civilization · Brand gold `#C08D23` · Step 4 of the 10-step run-rate plan*
