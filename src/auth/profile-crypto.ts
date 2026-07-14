/**
 * At-rest profile encryption (AES-256-GCM) for stored credentials.
 *
 * Each profile is encrypted with a per-profile subkey derived from the master
 * key + a fixed per-install salt (see profile-key.ts) via HKDF-SHA256, so a
 * leaked/backed-up/committed data dir never exposes plaintext cookies. Uses only
 * built-in `node:crypto`.
 */

import crypto from 'node:crypto';

export interface ProfileEnvelope {
  v: 1;
  alg: 'AES-256-GCM';
  nonce: string; // base64
  ct: string;    // base64 ciphertext
  tag: string;   // base64 GCM auth tag
}

/** Derive a per-profile 32-byte subkey. `profileId` is `<platform>:<name>`. */
function subkey(masterKey: Buffer, salt: Buffer, profileId: string): Buffer {
  const info = Buffer.from(`crossmind:profile:${profileId}`, 'utf8');
  return Buffer.from(crypto.hkdfSync('sha256', masterKey, salt, info, 32));
}

/** Encrypt plaintext into a self-describing JSON envelope string. */
export function encryptProfile(
  plaintext: string,
  masterKey: Buffer,
  salt: Buffer,
  profileId: string,
): string {
  const key = subkey(masterKey, salt, profileId);
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(profileId, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const envelope: ProfileEnvelope = {
    v: 1,
    alg: 'AES-256-GCM',
    nonce: nonce.toString('base64'),
    ct: ct.toString('base64'),
    tag: tag.toString('base64'),
  };
  return JSON.stringify(envelope);
}

/** Decrypt an envelope string produced by encryptProfile. Throws on tamper/wrong key. */
export function decryptProfile(
  envelopeRaw: string,
  masterKey: Buffer,
  salt: Buffer,
  profileId: string,
): string {
  const env = JSON.parse(envelopeRaw) as ProfileEnvelope;
  const key = subkey(masterKey, salt, profileId);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.nonce, 'base64'));
  decipher.setAAD(Buffer.from(profileId, 'utf8'));
  decipher.setAuthTag(Buffer.from(env.tag, 'base64'));
  const pt = Buffer.concat([decipher.update(Buffer.from(env.ct, 'base64')), decipher.final()]);
  return pt.toString('utf8');
}
