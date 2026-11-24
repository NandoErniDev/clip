/**
 * Access tokens.
 *
 * A token is 160 bits from the platform CSPRNG, rendered as Crockford base32
 * in groups of four for readability. Only the SHA-256 hash of the normalized
 * token is ever stored, so a database leak does not expose live clipboards.
 */

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TOKEN_BYTES = 20;
const TOKEN_LENGTH = 32;
const PREFIX = "CLIP";

function base32Encode(bytes: Uint8Array): string {
  let output = "";
  let buffer = 0;
  let bits = 0;

  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += ALPHABET[(buffer << (5 - bits)) & 31];
  }
  return output;
}

/** Generates a new token, e.g. CLIP-7Q4M-... (160 bits of entropy). */
export function generateToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  const body = base32Encode(bytes).slice(0, TOKEN_LENGTH);
  const groups = body.match(/.{1,4}/g) ?? [];
  return [PREFIX, ...groups].join("-");
}

/**
 * Normalizes user input: strips separators, uppercases, and removes the CLIP
 * prefix. Tokens are always 32 Crockford base32 characters once normalized.
 */
export function normalizeToken(input: string): string {
  const compact = input.toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (compact.length === TOKEN_LENGTH + PREFIX.length && compact.startsWith(PREFIX)) {
    return compact.slice(PREFIX.length);
  }
  return compact;
}

export function isTokenFormat(normalized: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{32}$/.test(normalized);
}

/** SHA-256 hex digest of a normalized token. */
export async function hashToken(normalized: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`clip:v1:${normalized}`));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Picks a short, non-reversible identifier for logs. */
export function tokenFingerprint(hash: string): string {
  return hash.slice(0, 12);
}
