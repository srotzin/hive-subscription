// Spectral ed25519 sign/verify — hive-subscription
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

let _privKey = null;
let _pubKey  = null;
let _pubKeyB64 = null;

function dataDir() {
  return process.env.DATA_DIR || (process.env.RENDER ? '/opt/render/project/data' : './data');
}

export function initKeypair() {
  const privEnv = process.env.SPECTRAL_PRIVKEY_B64;
  const pubEnv  = process.env.SPECTRAL_PUBKEY_B64;

  if (privEnv && pubEnv) {
    // privEnv is pkcs8 DER base64
    const privDer = Buffer.from(privEnv, 'base64');
    const keyObj  = crypto.createPrivateKey({ key: privDer, format: 'der', type: 'pkcs8' });
    _privKey = keyObj;
    const pubObj = crypto.createPublicKey(keyObj);
    _pubKey = pubObj;
    _pubKeyB64 = Buffer.from(pubObj.export({ type: 'spki', format: 'der' })).toString('base64');
    console.log('Spectral keypair loaded from env. pubkey:', _pubKeyB64.slice(0, 20) + '...');
    return;
  }

  const keyFile = path.join(dataDir(), 'spectral.key');
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
  } catch (_) {}

  if (fs.existsSync(keyFile)) {
    const { privB64 } = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
    // privB64 is pkcs8 DER base64
    const privDer = Buffer.from(privB64, 'base64');
    const keyObj  = crypto.createPrivateKey({ key: privDer, format: 'der', type: 'pkcs8' });
    _privKey = keyObj;
    const pubObj = crypto.createPublicKey(keyObj);
    _pubKey = pubObj;
    _pubKeyB64 = Buffer.from(pubObj.export({ type: 'spki', format: 'der' })).toString('base64');
    console.log('Spectral keypair loaded from disk. pubkey:', _pubKeyB64.slice(0, 20) + '...');
  } else {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    _privKey = privateKey;
    _pubKey = publicKey;
    _pubKeyB64 = Buffer.from(publicKey.export({ type: 'spki', format: 'der' })).toString('base64');
    const privSeed = Buffer.from(privateKey.export({ type: 'pkcs8', format: 'der' })).toString('base64');
    fs.writeFileSync(keyFile, JSON.stringify({ privB64: privSeed, pubB64: _pubKeyB64 }), { mode: 0o600 });
    console.log('Spectral keypair generated fresh. pubkey:', _pubKeyB64.slice(0, 20) + '...');
    console.log('SPECTRAL_PRIVKEY_B64=' + privSeed);
    console.log('SPECTRAL_PUBKEY_B64=' + _pubKeyB64);
  }
}

export function getPublicKeyB64() { return _pubKeyB64; }

export function signPayload(payload) {
  const payloadStr = JSON.stringify(payload);
  const payloadHash = crypto.createHash('sha256').update(payloadStr).digest('hex');
  const sig = crypto.sign(null, Buffer.from(payloadStr), _privKey);
  return {
    signature:              sig.toString('base64'),
    public_key:             _pubKeyB64,
    signed_payload_sha256:  payloadHash,
    signature_algo:         'ed25519'
  };
}

export function verifyEnvelope(envelope) {
  try {
    const { signature, public_key, signed_payload_sha256, signature_algo, ...payload } = envelope;
    if (signature_algo !== 'ed25519') return { valid: false, error: 'unsupported algo' };
    const payloadStr   = JSON.stringify(payload);
    const computedHash = crypto.createHash('sha256').update(payloadStr).digest('hex');
    if (computedHash !== signed_payload_sha256) return { valid: false, error: 'payload hash mismatch' };
    const pubKeyDer = Buffer.from(public_key, 'base64');
    const pubKeyObj = crypto.createPublicKey({ key: pubKeyDer, format: 'der', type: 'spki' });
    const ok = crypto.verify(null, Buffer.from(payloadStr), pubKeyObj, Buffer.from(signature, 'base64'));
    return { valid: ok };
  } catch (e) {
    return { valid: false, error: e.message };
  }
}

export function getJwks() {
  const der    = Buffer.from(_pubKeyB64, 'base64');
  // Extract 32-byte raw key from SPKI DER (last 32 bytes)
  const raw    = der.slice(-32);
  const x      = raw.toString('base64url');
  return {
    keys: [{
      kty: 'OKP',
      crv: 'Ed25519',
      use: 'sig',
      alg: 'EdDSA',
      x,
      kid: 'spectral-subscription-1'
    }]
  };
}
