// File-based JSON storage — hive-subscription
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

function dataDir() {
  return process.env.DATA_DIR || (process.env.RENDER ? '/opt/render/project/data' : './data');
}

function subFile() { return path.join(dataDir(), 'subscriptions.json'); }

function loadAll() {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    const raw = fs.readFileSync(subFile(), 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return {};
  }
}

function saveAll(store) {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(subFile(), JSON.stringify(store, null, 2));
}

export function createSubscription(fields) {
  const store = loadAll();
  const id    = 'sub_' + crypto.randomBytes(16).toString('hex');
  const now   = Date.now();
  const obj   = {
    id,
    payer_did:       fields.payer_did,
    merchant_did:    fields.merchant_did,
    amount_atomic:   fields.amount_atomic,
    currency:        fields.currency || 'USDC',
    chain:           fields.chain || 'base',
    period_seconds:  fields.period_seconds,
    period_index:    0,
    status:          'active',
    created_at:      new Date(now).toISOString(),
    signed_contract: fields.signed_contract || null,
    last_renewed_at: null,
    next_renewal_at: new Date(now + fields.period_seconds * 1000).toISOString()
  };
  store[id] = obj;
  saveAll(store);
  return obj;
}

export function getSubscription(id) {
  const store = loadAll();
  return store[id] || null;
}

export function updateSubscription(id, updates) {
  const store = loadAll();
  if (!store[id]) return null;
  store[id] = { ...store[id], ...updates };
  saveAll(store);
  return store[id];
}

export function listSubscriptionsByDid(did) {
  const store = loadAll();
  return Object.values(store).filter(s => s.payer_did === did || s.merchant_did === did);
}

export function renewalIdempotencyKey(subscription_id, period_index) {
  return `${subscription_id}:${period_index}`;
}

// Track idempotency keys for renewals
function renewalFile() { return path.join(dataDir(), 'renewals.json'); }

function loadRenewals() {
  try {
    return JSON.parse(fs.readFileSync(renewalFile(), 'utf8'));
  } catch (_) {
    return {};
  }
}

function saveRenewals(store) {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(renewalFile(), JSON.stringify(store, null, 2));
}

export function recordRenewal(subscription_id, period_index, receipt) {
  const store = loadRenewals();
  const key   = renewalIdempotencyKey(subscription_id, period_index);
  store[key]  = receipt;
  saveRenewals(store);
}

export function getRenewal(subscription_id, period_index) {
  const store = loadRenewals();
  return store[renewalIdempotencyKey(subscription_id, period_index)] || null;
}
