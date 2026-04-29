import express from 'express';
import crypto from 'crypto';
import { initKeypair, getPublicKeyB64, signPayload, verifyEnvelope, getJwks } from './lib/spectral.js';
import {
  createSubscription, getSubscription, updateSubscription,
  listSubscriptionsByDid, recordRenewal, getRenewal
} from './lib/storage.js';

const app  = express();
app.use(express.json());

const PORT    = process.env.PORT || 3000;
const MONROE  = '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const NETWORK = 'base';
const CHAIN_ID = 8453;

// Pricing (USDC 6-decimal atomic)
const HIVE_TAKE_PCT  = 2;                  // 2% of renewal
const FLAT_FEE       = 5000;              // $0.005 = 5000 micro-USDC

// Init Spectral keypair (file-persisted at data/spectral.key or from env)
initKeypair();

// ─── helpers ──────────────────────────────────────────────────────────────────

function calcRenewalFee(amount_atomic) {
  // Renewal fee: 2% of amount + $0.005 flat
  return Math.floor(amount_atomic * 0.02) + FLAT_FEE;
}

function make402Challenge(amount_atomic, resource, description) {
  return {
    scheme:            'exact',
    network:           NETWORK,
    chainId:           CHAIN_ID,
    asset:             'USDC',
    contract:          USDC_BASE,
    maxAmountRequired: String(amount_atomic),
    payTo:             MONROE,
    resource,
    description:       description || 'Hive subscription renewal — x402 gated.',
    mimeType:          'application/json'
  };
}

function require402(req, res, amount_atomic, resource, description) {
  const xPayment = req.headers['x-payment'];
  if (!xPayment) {
    res.status(402).set({ 'X-Payment-Required': 'true', 'Content-Type': 'application/json' });
    res.json({
      x402_version: '0.2.0',
      error:        'Payment Required',
      accepts:      [make402Challenge(amount_atomic, resource, description)]
    });
    return false;
  }
  return true;
}

// ─── wellknown / health ───────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({
    status:          'ok',
    service:         'hive-subscription',
    version:         '1.0.0',
    monroe:          MONROE,
    hive_take_pct:   HIVE_TAKE_PCT,
    ts:              new Date().toISOString()
  });
});

app.get('/.well-known/agent.json', (req, res) => {
  res.json({
    name:        'hive-subscription',
    version:     '1.0.0',
    description: 'Recurring x402 subscription primitive. ed25519-signed renewal contracts. Pause/resume/cancel at agent-speed. Zero merchant-of-record overhead.',
    brand_color: '#C08D23',
    did:         `did:web:${req.hostname}`,
    treasury: {
      evm:     MONROE,
      chain:   NETWORK,
      chain_id: CHAIN_ID
    },
    spectral: {
      public_key:    getPublicKeyB64(),
      signature_algo: 'ed25519',
      jwks_endpoint: '/.well-known/jwks.json'
    },
    payment: {
      protocol:             'x402',
      network:              NETWORK,
      chain_id:             CHAIN_ID,
      asset:                'USDC',
      contract:             USDC_BASE,
      payTo:                MONROE,
      hive_take_pct:        HIVE_TAKE_PCT,
      renewal_fee_flat:     FLAT_FEE,
      description:          'Renewal fee: 2% of subscription amount + $0.005 flat. Hive take: 2% (15% of total fee).'
    },
    capabilities: [
      'subscription.create',
      'subscription.renew',
      'subscription.pause',
      'subscription.resume',
      'subscription.cancel',
      'subscription.list',
      'subscription.get'
    ],
    mcp_endpoint: '/mcp',
    tools: ['create_subscription', 'renew_subscription', 'manage_subscription', 'list_subscriptions']
  });
});

app.get('/.well-known/jwks.json', (_req, res) => {
  res.json(getJwks());
});

app.get('/.well-known/mcp.json', (_req, res) => {
  res.json({
    mcp_version:   '2024-11-05',
    transport:     'streamable-http',
    endpoint:      '/mcp',
    service:       'hive-subscription',
    tools_count:   4
  });
});

// ─── MCP JSON-RPC ─────────────────────────────────────────────────────────────

app.post('/mcp', async (req, res) => {
  const { jsonrpc, id, method, params } = req.body || {};
  if (jsonrpc !== '2.0') {
    return res.status(400).json({ jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } });
  }

  if (method === 'tools/list') {
    return res.json({
      jsonrpc: '2.0', id,
      result: {
        tools: [
          {
            name: 'create_subscription',
            description: 'Create a recurring x402 subscription between a payer DID and a merchant DID. Returns a subscription_id and an ed25519-signed renewal contract. No payment required at create — payer pays on each renewal.',
            inputSchema: {
              type: 'object',
              required: ['payer_did', 'merchant_did', 'amount_atomic', 'period_seconds'],
              properties: {
                payer_did:       { type: 'string', description: 'DID of the subscribing agent.' },
                merchant_did:    { type: 'string', description: 'DID of the merchant receiving payment.' },
                amount_atomic:   { type: 'integer', description: 'Subscription amount per period in USDC micro-units (6 decimals). E.g. 5000000 = $5.00.' },
                period_seconds:  { type: 'integer', description: 'Billing period in seconds. E.g. 2592000 = 30 days.' },
                currency:        { type: 'string', enum: ['USDC'], default: 'USDC', description: 'Settlement currency.' },
                chain:           { type: 'string', enum: ['base'], default: 'base', description: 'Settlement chain.' }
              }
            }
          },
          {
            name: 'renew_subscription',
            description: 'Renew a subscription for the current period. Requires x402 payment of (amount_atomic × 2%) + $0.005 flat. Idempotent on (subscription_id, period_index). Returns a Spectral-signed renewal receipt.',
            inputSchema: {
              type: 'object',
              required: ['subscription_id'],
              properties: {
                subscription_id: { type: 'string', description: 'Subscription ID returned by create_subscription.' },
                x_payment:       { type: 'string', description: 'X-PAYMENT header value (base64 encoded x402 payment proof). Pass via HTTP header X-PAYMENT — this field is informational.' }
              }
            }
          },
          {
            name: 'manage_subscription',
            description: 'Pause, resume, or cancel a subscription. Both the payer DID and merchant DID can manage.',
            inputSchema: {
              type: 'object',
              required: ['subscription_id', 'action', 'caller_did'],
              properties: {
                subscription_id: { type: 'string' },
                action:         { type: 'string', enum: ['pause', 'resume', 'cancel'], description: 'Management action.' },
                caller_did:     { type: 'string', description: 'DID of the calling agent. Must match payer_did or merchant_did.' }
              }
            }
          },
          {
            name: 'list_subscriptions',
            description: 'List all active subscriptions for a given DID (as payer or merchant).',
            inputSchema: {
              type: 'object',
              required: ['did'],
              properties: {
                did:    { type: 'string', description: 'DID to list subscriptions for.' },
                status: { type: 'string', enum: ['active', 'paused', 'cancelled', 'all'], default: 'active', description: 'Filter by status.' }
              }
            }
          }
        ]
      }
    });
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const args     = params?.arguments || {};

    if (toolName === 'create_subscription') {
      const { payer_did, merchant_did, amount_atomic, period_seconds, currency, chain } = args;
      if (!payer_did || !merchant_did || !amount_atomic || !period_seconds) {
        return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ error: 'payer_did, merchant_did, amount_atomic, period_seconds required' }) }] } });
      }
      const contract = {
        payer_did, merchant_did,
        amount_atomic: Number(amount_atomic),
        currency: currency || 'USDC',
        chain: chain || 'base',
        period_seconds: Number(period_seconds),
        renewal_fee_description: `2% of amount_atomic + ${FLAT_FEE} micro-USDC ($0.005) per period`,
        hive_take_pct: HIVE_TAKE_PCT,
        created_at: new Date().toISOString()
      };
      const signed = signPayload(contract);
      const sub = createSubscription({ ...contract, signed_contract: { ...contract, ...signed } });
      return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(sub) }] } });
    }

    if (toolName === 'renew_subscription') {
      const { subscription_id } = args;
      const note = {
        note: 'renew_subscription requires x402 payment. Use POST /v1/subscription/renew with X-PAYMENT header.',
        subscription_id,
        x402_challenge_example: 'Send POST /v1/subscription/renew with body {subscription_id} and X-PAYMENT header.'
      };
      const sub = getSubscription(subscription_id);
      if (sub) {
        note.renewal_fee_atomic = calcRenewalFee(sub.amount_atomic);
        note.x402_challenge = make402Challenge(
          calcRenewalFee(sub.amount_atomic),
          `/v1/subscription/renew`,
          `Renew subscription ${subscription_id} — period ${sub.period_index + 1}`
        );
      }
      return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(note) }] } });
    }

    if (toolName === 'manage_subscription') {
      const { subscription_id, action, caller_did } = args;
      const sub = getSubscription(subscription_id);
      if (!sub) return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ error: 'subscription not found' }) }] } });
      if (sub.payer_did !== caller_did && sub.merchant_did !== caller_did) {
        return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ error: 'caller_did not authorized' }) }] } });
      }
      if (!['pause', 'resume', 'cancel'].includes(action)) {
        return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ error: 'invalid action' }) }] } });
      }
      const statusMap = { pause: 'paused', resume: 'active', cancel: 'cancelled' };
      const updated = updateSubscription(subscription_id, { status: statusMap[action], updated_at: new Date().toISOString() });
      return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(updated) }] } });
    }

    if (toolName === 'list_subscriptions') {
      const { did, status } = args;
      if (!did) return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ error: 'did required' }) }] } });
      let subs = listSubscriptionsByDid(did);
      if (status && status !== 'all') subs = subs.filter(s => s.status === status);
      return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ did, count: subs.length, subscriptions: subs }) }] } });
    }

    return res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${toolName}` } });
  }

  return res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
});

// ─── REST endpoints ───────────────────────────────────────────────────────────

// POST /v1/subscription/create
app.post('/v1/subscription/create', (req, res) => {
  const { payer_did, merchant_did, amount_atomic, period_seconds, currency, chain } = req.body || {};
  if (!payer_did || !merchant_did || !amount_atomic || !period_seconds) {
    return res.status(400).json({ error: 'payer_did, merchant_did, amount_atomic, period_seconds required' });
  }
  const contract = {
    payer_did, merchant_did,
    amount_atomic:  Number(amount_atomic),
    currency:       currency || 'USDC',
    chain:          chain   || 'base',
    period_seconds: Number(period_seconds),
    renewal_fee_description: `2% of amount_atomic + ${FLAT_FEE} micro-USDC ($0.005) per period`,
    hive_take_pct:  HIVE_TAKE_PCT,
    created_at:     new Date().toISOString()
  };
  const signed  = signPayload(contract);
  const sub     = createSubscription({ ...contract, signed_contract: { ...contract, ...signed } });
  res.status(201).json(sub);
});

// POST /v1/subscription/renew — x402 gated
app.post('/v1/subscription/renew', (req, res) => {
  const { subscription_id } = req.body || {};
  if (!subscription_id) return res.status(400).json({ error: 'subscription_id required' });

  const sub = getSubscription(subscription_id);
  if (!sub) return res.status(404).json({ error: 'subscription not found' });
  if (sub.status === 'cancelled') return res.status(410).json({ error: 'subscription cancelled' });
  if (sub.status === 'paused')    return res.status(409).json({ error: 'subscription paused — resume first' });

  const renewalFee = calcRenewalFee(sub.amount_atomic);

  // Idempotency check
  const existing = getRenewal(subscription_id, sub.period_index);
  if (existing) return res.json({ ...existing, idempotent: true });

  // x402 gate
  if (!require402(req, res, renewalFee, '/v1/subscription/renew', `Renew subscription ${subscription_id} — period ${sub.period_index + 1}. Amount: ${renewalFee} micro-USDC.`)) return;

  const now           = new Date();
  const nextRenewalAt = new Date(now.getTime() + sub.period_seconds * 1000).toISOString();
  const receiptPayload = {
    subscription_id,
    period_index:      sub.period_index + 1,
    amount_atomic:     sub.amount_atomic,
    renewal_fee_atomic: renewalFee,
    currency:          sub.currency,
    chain:             sub.chain,
    payer_did:         sub.payer_did,
    merchant_did:      sub.merchant_did,
    renewed_at:        now.toISOString(),
    next_renewal_at:   nextRenewalAt
  };
  const signed = signPayload(receiptPayload);
  const receipt = { ...receiptPayload, ...signed };

  recordRenewal(subscription_id, sub.period_index + 1, receipt);
  updateSubscription(subscription_id, {
    period_index:    sub.period_index + 1,
    last_renewed_at: now.toISOString(),
    next_renewal_at: nextRenewalAt
  });

  res.json(receipt);
});

// POST /v1/subscription/pause
app.post('/v1/subscription/pause', (req, res) => {
  const { subscription_id, caller_did } = req.body || {};
  if (!subscription_id || !caller_did) return res.status(400).json({ error: 'subscription_id and caller_did required' });
  const sub = getSubscription(subscription_id);
  if (!sub) return res.status(404).json({ error: 'subscription not found' });
  if (sub.payer_did !== caller_did && sub.merchant_did !== caller_did) return res.status(403).json({ error: 'not authorized' });
  if (sub.status === 'cancelled') return res.status(410).json({ error: 'subscription cancelled' });
  const updated = updateSubscription(subscription_id, { status: 'paused', paused_at: new Date().toISOString() });
  res.json(updated);
});

// POST /v1/subscription/resume
app.post('/v1/subscription/resume', (req, res) => {
  const { subscription_id, caller_did } = req.body || {};
  if (!subscription_id || !caller_did) return res.status(400).json({ error: 'subscription_id and caller_did required' });
  const sub = getSubscription(subscription_id);
  if (!sub) return res.status(404).json({ error: 'subscription not found' });
  if (sub.payer_did !== caller_did && sub.merchant_did !== caller_did) return res.status(403).json({ error: 'not authorized' });
  if (sub.status === 'cancelled') return res.status(410).json({ error: 'subscription cancelled' });
  const updated = updateSubscription(subscription_id, {
    status: 'active',
    paused_at: null,
    next_renewal_at: new Date(Date.now() + sub.period_seconds * 1000).toISOString()
  });
  res.json(updated);
});

// POST /v1/subscription/cancel
app.post('/v1/subscription/cancel', (req, res) => {
  const { subscription_id, caller_did } = req.body || {};
  if (!subscription_id || !caller_did) return res.status(400).json({ error: 'subscription_id and caller_did required' });
  const sub = getSubscription(subscription_id);
  if (!sub) return res.status(404).json({ error: 'subscription not found' });
  if (sub.payer_did !== caller_did && sub.merchant_did !== caller_did) return res.status(403).json({ error: 'not authorized' });
  const updated = updateSubscription(subscription_id, { status: 'cancelled', cancelled_at: new Date().toISOString() });
  res.json(updated);
});

// GET /v1/subscription/list?did=X
app.get('/v1/subscription/list', (req, res) => {
  const { did, status } = req.query;
  if (!did) return res.status(400).json({ error: 'did query param required' });
  let subs = listSubscriptionsByDid(did);
  if (status && status !== 'all') subs = subs.filter(s => s.status === status);
  res.json({ did, count: subs.length, subscriptions: subs });
});

// GET /v1/subscription/:id
app.get('/v1/subscription/:id', (req, res) => {
  const sub = getSubscription(req.params.id);
  if (!sub) return res.status(404).json({ error: 'subscription not found' });
  res.json(sub);
});

// ─── server start ─────────────────────────────────────────────────────────────

// ── well-known / x402 ─────────────────────────────────────────────────────────

app.get('/.well-known/x402', (_req, res) => {
  res.json({
    x402Version:  2,
    cold_safe:    true,
    service:      'hive-subscription',
    version:      '1.0.0',
    brand_color:  '#C08D23',
    payTo:        '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e',
    network:      'base',
    chain_id:     8453,
    asset:        'USDC',
    contract:     '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    accepted_assets: [
      {
        symbol:    'USDC',
        contract:  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        network:   'base',
        chain_id:  8453,
        primary:   true
      },
      {
        symbol:    'USDT',
        contract:  '0xfde4C96c8593536E31F229Ea8f37b2ADa2699bb2',
        network:   'base',
        chain_id:  8453,
        primary:   false
      },
      {
        symbol:               'USAd',
        program_id:           'usad_stablecoin.aleo',
        network:              'aleo',
        network_name:         'aleo-mainnet',
        primary:              false,
        issuer:               'Paxos Labs',
        backing:              'Paxos Trust USDG 1:1',
        privacy:              'zk-default',
        docs:                 'https://aleo.org/usad',
        facilitator:          'https://hive-aleo-arc.onrender.com/v1/facilitator',
        facilitator_treasury: 'aleo1cyk7r2jmd7lfcftzyy85z4j5x6rlern598qecx8v2ms738xcvgyq72q6tk',
        added:                '2026-04-29'
      },
      {
        symbol:               'USDCx',
        program_id:           'usdcx_stablecoin.aleo',
        network:              'aleo',
        network_name:         'aleo-mainnet',
        primary:              false,
        issuer:               'Circle xReserve',
        backing:              'USDC 1:1 (Ethereum reserve)',
        privacy:              'zk-default',
        docs:                 'https://aleo.org/usdcx',
        facilitator:          'https://hive-aleo-arc.onrender.com/v1/facilitator',
        facilitator_treasury: 'aleo1cyk7r2jmd7lfcftzyy85z4j5x6rlern598qecx8v2ms738xcvgyq72q6tk',
        added:                '2026-04-29'
      }
    ],
    facilitator: {
      url:                    'https://hive-aleo-arc.onrender.com/v1/facilitator',
      supported_schemes:      ['exact'],
      supported_networks:     ['eip155:8453', 'aleo-mainnet'],
      syncFacilitatorOnStart: false,
      cold_safe:              true,
      aleo_treasury:          'aleo1cyk7r2jmd7lfcftzyy85z4j5x6rlern598qecx8v2ms738xcvgyq72q6tk',
      usad_program_id:        'usad_stablecoin.aleo',
      usdcx_program_id:       'usdcx_stablecoin.aleo',
    },
    resources: [
      {
        path:        '/v1/subscription/renew',
        method:      'POST',
        description: 'Renew a subscription. Fee: 2% of amount_atomic + $0.005 flat. Hive take: 2%.',
        'x-pricing': {
          scheme: 'exact',
          asset: 'USDC',
          hive_take_pct: 2,
          flat_fee_atomic: 5000,
          variable_pct: 2,
          payTo: '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e',
          description: '2% of amount_atomic + 5000 micro-USDC flat per renewal.',
        },
        'x-payment-info': {
          scheme: 'exact',
          asset: 'USDC',
          hive_take_pct: 2,
          flat_fee_atomic: 5000,
          variable_pct: 2,
          payTo: '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e',
          description: '2% of amount_atomic + 5000 micro-USDC flat per renewal.',
        }
      },
      {
        path:        '/v1/subscription/create',
        method:      'POST',
        description: 'Create a recurring subscription contract. No payment at create.',
        'x-pricing':      { scheme: 'free', note: 'Subscription create is free. Renewals are x402 gated.' },
        'x-payment-info': { scheme: 'free', note: 'Subscription create is free. Renewals are x402 gated.' }
      },
      {
        path:        '/v1/subscription/pause',
        method:      'POST',
        description: 'Pause a subscription. No fee.',
        'x-pricing':      { scheme: 'free', note: 'Pause is free.' },
        'x-payment-info': { scheme: 'free', note: 'Pause is free.' }
      },
      {
        path:        '/v1/subscription/cancel',
        method:      'POST',
        description: 'Cancel a subscription. No fee.',
        'x-pricing':      { scheme: 'free', note: 'Cancel is free.' },
        'x-payment-info': { scheme: 'free', note: 'Cancel is free.' }
      }
    ],
    discovery_companions: {
      agent_card: '/.well-known/agent-card.json',
      ap2:        '/.well-known/ap2.json',
      openapi:    '/.well-known/openapi.json'
    },
    disclaimers: {
      not_a_security: true,
      not_custody:    true,
      not_insurance:  true,
      signal_only:    true
    }
  });
});

// ── well-known / agent-card.json (A2A 0.1) ────────────────────────────────────

app.get('/.well-known/agent-card.json', (req, res) => {
  const pubkey = (typeof getPublicKeyB64 === 'function')
    ? getPublicKeyB64()
    : (typeof spectral !== 'undefined' ? (spectral.publicKeyB64 || null) : null);
  res.json({
    name:        'hive-subscription',
    version:     '1.0.0',
    description: 'Recurring x402 subscription primitive. ed25519-signed renewal contracts. Pause/resume/cancel at agent-speed.',
    brand_color: '#C08D23',
    did:         `did:web:${req.hostname}`,
    protocol:    'A2A/0.1',
    capabilities: [
      'subscription.create',
      'subscription.renew',
      'subscription.pause',
      'subscription.resume',
      'subscription.cancel',
      'subscription.list'
    ],
    spectral: {
      public_key:    pubkey,
      signature_algo: 'ed25519',
      jwks_endpoint: '/.well-known/jwks.json'
    },
    treasury: {
      address:  '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e',
      network:  'base',
      chain_id: 8453,
      asset:    'USDC'
    },
    payment: {
      protocol: 'x402',
      version:  '2',
      network:  'base',
      chain_id: 8453,
      asset:    'USDC',
      contract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      payTo:    '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e'
    },
    mcp_endpoint: '/mcp',
    tools: ['create_subscription', 'renew_subscription', 'manage_subscription', 'list_subscriptions']
  });
});

// ── well-known / ap2.json (AP2 0.1) ───────────────────────────────────────────

app.get('/.well-known/ap2.json', (_req, res) => {
  res.json({
    ap2_version:   '0.1',
    service:       'hive-subscription',
    accepted_tokens: [
      {
        symbol:   'USDC',
        contract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        network:  'base',
        chain_id: 8453,
        decimals: 6
      },
      {
        symbol:   'USDT',
        contract: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
        network:  'base',
        chain_id: 8453,
        decimals: 6,
        role:     'alternate'
      }
    ],
    networks:           [{ name: 'base', chain_id: 8453, role: 'primary' }],
    payment_protocols:  ['x402/v2'],
    settlement: {
      finality:  'on-chain',
      network:   'base',
      chain_id:  8453,
      payTo:     '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e'
    },
    paid_endpoints: [
      { path: '/v1/subscription/renew', method: 'POST', description: 'Renew a subscription. Fee: 2% of amount_atomic + $0.005 flat. Hive take: 2%.' }
    ],
    free_endpoints: [
      { path: '/v1/subscription/create', method: 'POST', description: 'Create a recurring subscription contract. No payment at create.' },
      { path: '/v1/subscription/pause', method: 'POST', description: 'Pause a subscription. No fee.' },
      { path: '/v1/subscription/cancel', method: 'POST', description: 'Cancel a subscription. No fee.' }
    ],
    brand_color: '#C08D23'
  });
});

// ── well-known / openapi.json (OpenAPI 3.0.3 + x-pricing + x-payment-info) ────

app.get('/.well-known/openapi.json', (_req, res) => {
  res.json({
    openapi: '3.0.3',
    info: {
      title:       'hive-subscription API',
      version:     '1.0.0',
      description: 'Recurring x402 subscription primitive. ed25519-signed renewal contracts. Pause/resume/cancel at agent-speed.',
      contact:     { name: 'The Hivery', url: 'https://thehiveryiq.com' }
    },
    servers: [{ url: 'https://hive-subscription.onrender.com', description: 'Production (Render)' }],
    paths: {
      '/v1/subscription/renew': {
        post: {
          operationId: 'v1_subscription_renew',
          summary: 'Renew a subscription. Fee: 2% of amount_atomic + $0.005 flat. Hive take: 2%.',
          'x-pricing': {
          scheme: 'exact',
          asset: 'USDC',
          hive_take_pct: 2,
          flat_fee_atomic: 5000,
          variable_pct: 2,
          payTo: '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e',
          description: '2% of amount_atomic + 5000 micro-USDC flat per renewal.'
          },
          'x-payment-info': {
          scheme: 'exact',
          asset: 'USDC',
          hive_take_pct: 2,
          flat_fee_atomic: 5000,
          variable_pct: 2,
          payTo: '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e',
          description: '2% of amount_atomic + 5000 micro-USDC flat per renewal.'
          },
          responses: {
            '200': { description: 'Success.' },
            '402': { description: 'Payment Required — x402 challenge.' },
            '400': { description: 'Validation error.' }
          }
        }
      },
      '/v1/subscription/create': {
        post: {
          operationId: 'v1_subscription_create',
          summary: 'Create a recurring subscription contract. No payment at create.',
          responses: {
            '200': { description: 'Success.' },
            '400': { description: 'Validation error.' }
          }
        }
      },
      '/v1/subscription/pause': {
        post: {
          operationId: 'v1_subscription_pause',
          summary: 'Pause a subscription. No fee.',
          responses: {
            '200': { description: 'Success.' },
            '400': { description: 'Validation error.' }
          }
        }
      },
      '/v1/subscription/cancel': {
        post: {
          operationId: 'v1_subscription_cancel',
          summary: 'Cancel a subscription. No fee.',
          responses: {
            '200': { description: 'Success.' },
            '400': { description: 'Validation error.' }
          }
        }
      }
    }
  });
});

app.listen(PORT, () => {
  console.log(`hive-subscription listening on :${PORT}`);
});
