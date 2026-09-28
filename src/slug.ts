// Generated slugs (DESIGN D2): 7 characters from [A-Za-z0-9], drawn from
// crypto.getRandomValues. Case-sensitive. Collisions and reserved words are
// handled by the caller, which retries with a fresh slug.

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const LENGTH = 7;
// Largest multiple of 62 that fits in a byte. Bytes at or above it are
// discarded so every character is equally likely (no modulo bias).
const LIMIT = 256 - (256 % ALPHABET.length);

export const RESERVED_SLUGS: ReadonlySet<string> = new Set(["api", "healthz"]);

export function generateSlug(): string {
  let slug = "";
  const bytes = new Uint8Array(16);
  while (slug.length < LENGTH) {
    crypto.getRandomValues(bytes);
    for (const b of bytes) {
      if (b >= LIMIT) continue;
      slug += ALPHABET[b % ALPHABET.length];
      if (slug.length === LENGTH) break;
    }
  }
  return slug;
}
