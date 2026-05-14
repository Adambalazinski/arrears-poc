import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decrypt, encrypt } from '../credential-crypto';
import { CredentialDecryptionError } from '../credential-store.interface';

const key = (): Buffer => randomBytes(32);

describe('credential crypto', () => {
  it('round-trips a plaintext token under the same key', () => {
    const k = key();
    const plaintext = 'eyJfake.access.token-' + '✨'.repeat(20);
    const blob = encrypt(plaintext, k);
    expect(decrypt(blob, k)).toBe(plaintext);
  });

  it('produces a different blob each time (random IV)', () => {
    const k = key();
    const a = encrypt('same-token', k);
    const b = encrypt('same-token', k);
    expect(a.equals(b)).toBe(false);
    expect(decrypt(a, k)).toBe('same-token');
    expect(decrypt(b, k)).toBe('same-token');
  });

  it('fails decryption with the wrong key', () => {
    const blob = encrypt('hunter2', key());
    expect(() => decrypt(blob, key())).toThrowError(CredentialDecryptionError);
  });

  it('fails decryption when the ciphertext is tampered', () => {
    const k = key();
    const blob = encrypt('hunter2', k);
    // Flip a byte in the ciphertext portion (after IV+tag)
    const tampered = Buffer.from(blob);
    tampered[28] = (tampered[28] ?? 0) ^ 0xff;
    expect(() => decrypt(tampered, k)).toThrowError(CredentialDecryptionError);
  });

  it('rejects keys of the wrong length', () => {
    const shortKey = Buffer.alloc(16);
    expect(() => encrypt('x', shortKey)).toThrow(/must be 32 bytes/);
    expect(() => decrypt(Buffer.alloc(64), shortKey)).toThrow(/must be 32 bytes/);
  });

  it('rejects truncated blobs', () => {
    expect(() => decrypt(Buffer.alloc(10), key())).toThrowError(CredentialDecryptionError);
  });
});
