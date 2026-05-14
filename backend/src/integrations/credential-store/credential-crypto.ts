import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { CredentialDecryptionError } from './credential-store.interface';

// AES-256-GCM with a random 12-byte IV per encryption. The on-disk format is
// IV(12) || TAG(16) || CIPHERTEXT. Standard layout: anyone with the key can
// decrypt without out-of-band metadata.
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

export function encrypt(plaintext: string, key: Buffer): Buffer {
  if (key.length !== KEY_LEN) {
    throw new Error(`CREDENTIAL_ENCRYPTION_KEY must be ${KEY_LEN} bytes (got ${key.length})`);
  }
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]);
}

export function decrypt(blob: Buffer, key: Buffer): string {
  if (key.length !== KEY_LEN) {
    throw new Error(`CREDENTIAL_ENCRYPTION_KEY must be ${KEY_LEN} bytes (got ${key.length})`);
  }
  if (blob.length < IV_LEN + TAG_LEN + 1) {
    throw new CredentialDecryptionError(`ciphertext too short (${blob.length} bytes)`);
  }
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = blob.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plain.toString('utf-8');
  } catch (err) {
    // GCM tag mismatch (wrong key, tampered ciphertext) lands here.
    throw new CredentialDecryptionError(
      `decryption failed: ${err instanceof Error ? err.message : err}`,
    );
  }
}

export function loadKeyFromEnv(): Buffer {
  const raw = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!raw) throw new Error('CREDENTIAL_ENCRYPTION_KEY env var is required for LOCAL backend');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_LEN) {
    throw new Error(
      `CREDENTIAL_ENCRYPTION_KEY must decode to ${KEY_LEN} bytes (got ${key.length}); generate with: openssl rand -base64 32`,
    );
  }
  return key;
}
