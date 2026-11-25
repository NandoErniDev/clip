/**
 * Access codes.
 *
 * A clipboard is opened with a code. Codes are chosen by the user, so they are
 * intentionally short and memorable ("aaa", "4ever"), and compared
 * case-insensitively. Only the SHA-256 hash of the normalized code is stored,
 * so a database leak does not expose live clipboards.
 *
 * Short codes are weak against guessing by nature; the Worker rate-limits both
 * attempts per client and attempts per code.
 */

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TOKEN_BYTES = 20;
const TOKEN_LENGTH = 32;
const PREFIX = "CLIP";

export const CODE_RULES = {
  minLength: 3,
  maxLength: 64,
  /** Letters, digits and - _ . only. */
  pattern: /^[a-z0-9][a-z0-9._-]*$/,
} as const;

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

/** Generates a random code, e.g. CLIP-7Q4M-... (160 bits of entropy). */
export function generateToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  const body = base32Encode(bytes).slice(0, TOKEN_LENGTH);
  const groups = body.match(/.{1,4}/g) ?? [];
  return [PREFIX, ...groups].join("-");
}

/** Trimmed and lowercased, so codes are case-insensitive. */
export function normalizeToken(input: string): string {
  return input.trim().toLowerCase();
}

export function isTokenFormat(normalized: string): boolean {
  return (
    normalized.length >= CODE_RULES.minLength &&
    normalized.length <= CODE_RULES.maxLength &&
    CODE_RULES.pattern.test(normalized)
  );
}

/** SHA-256 hex digest of a normalized code. */
export async function hashToken(normalized: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`clip:v2:${normalized}`));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Picks a short, non-reversible identifier for logs. */
export function tokenFingerprint(hash: string): string {
  return hash.slice(0, 12);
}
