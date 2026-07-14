/**
 * Cross-repo interop driver for 联调. Invoked by the backend-side orchestration
 * script. Reads configuration from env and exercises the CLI's real crypto/store/
 * public-account code paths against artifacts produced by the backend.
 *
 * Modes (argv[2]):
 *   crypto-decrypt   read a backend exchange envelope JSON from stdin, decrypt
 *                    with env CM_TOKEN + CM_PROVIDER, print plaintext.
 *   store-roundtrip  env CM_PROFILE_KEY/CM_DATA_DIR/CM_PLATFORM/CM_NAME/CM_AUTH/CM_CT0
 *                    -> saveCredential then loadCredential, print {cred, enc, json}.
 *   fetch-public     env CM_API_BASE/CM_PUBLIC_TOKEN/CM_PROVIDER -> fetchPublicCredential,
 *                    print the decrypted credential (or null).
 */
import { readFile, access, readdir, readFile as rf } from 'node:fs/promises';
import { decryptEnvelope } from '../dist/auth/public-accounts.js';
import { saveCredential, loadCredential } from '../dist/auth/store.js';
import { _resetProfileKeyCache } from '../dist/auth/profile-key.js';

const mode = process.argv[2];

async function exists(p) { try { await access(p); return true; } catch { return false; } }

if (mode === 'crypto-decrypt') {
  const env = JSON.parse(await readFile('/dev/stdin', 'utf8'));
  const token = process.env['CM_TOKEN'];
  const provider = process.env['CM_PROVIDER'];
  console.log(decryptEnvelope(env, token, provider));
} else if (mode === 'store-roundtrip') {
  const dataDir = process.env['CM_DATA_DIR'];
  process.env['CROSSMIND_DATA_DIR'] = dataDir;
  process.env['CROSSMIND_PROFILE_KEY'] = process.env['CM_PROFILE_KEY'];
  _resetProfileKeyCache();
  const platform = process.env['CM_PLATFORM'];
  const name = process.env['CM_NAME'];
  await saveCredential({ platform, name, authToken: process.env['CM_AUTH'], ct0: process.env['CM_CT0'] });
  const cred = await loadCredential(platform, name);
  const enc = await exists(`${dataDir}/accounts/${platform}/${name}.enc`);
  const json = await exists(`${dataDir}/accounts/${platform}/${name}.json`);
  console.log(JSON.stringify({ cred, enc, json }));
} else if (mode === 'fetch-public') {
  const { fetchPublicCredential, _resetPublicCache } = await import('../dist/auth/public-accounts.js');
  process.env['CROSSMIND_API_BASE'] = process.env['CM_API_BASE'];
  process.env['CROSSMIND_PUBLIC_TOKEN'] = process.env['CM_PUBLIC_TOKEN'];
  _resetPublicCache();
  const cred = await fetchPublicCredential(process.env['CM_PROVIDER']);
  console.log(JSON.stringify(cred));
} else if (mode === 'load-gate') {
  // Exercise the gated loader for op=argv[3]; no local account, only public fallback.
  const { _resetPublicCache } = await import('../dist/auth/public-accounts.js');
  process.env['CROSSMIND_DATA_DIR'] = process.env['CM_DATA_DIR'];
  process.env['CROSSMIND_PROFILE_KEY'] = process.env['CM_PROFILE_KEY'];
  process.env['CROSSMIND_API_BASE'] = process.env['CM_API_BASE'];
  process.env['CROSSMIND_PUBLIC_TOKEN'] = process.env['CM_PUBLIC_TOKEN'];
  _resetPublicCache();
  const { _resetProfileKeyCache } = await import('../dist/auth/profile-key.js');
  _resetProfileKeyCache();
  const { loadXCredentials } = await import('../dist/auth/x.js');
  const op = process.argv[3];
  const creds = await loadXCredentials(undefined, undefined, op);
  console.log(JSON.stringify({ op, hasCred: !!creds }));
} else {
  console.error('unknown mode'); process.exit(2);
}
