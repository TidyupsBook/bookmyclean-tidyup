import crypto from "node:crypto";

/**
 * Symmetric encryption for third-party credentials we have to store and replay.
 * Currently used for each company's Quo API key and their Jobber OAuth tokens.
 * Quo has no OAuth flow, so the raw key is the only way to call their API on a
 * company's behalf; Jobber tokens are durable OAuth credentials — neither should
 * ever sit in the database in plaintext.
 *
 * The encryption key is derived from SESSION_SECRET via HKDF with a distinct
 * info label per credential type, so each key is cryptographically independent
 * even though they share a root secret.
 *
 * Rotating SESSION_SECRET invalidates every stored credential: companies would
 * have to reconnect Quo and re-authorize Jobber. `decryptSecret` returns null
 * rather than throwing so that case surfaces as "reconnect" instead of a crash.
 */

const VERSION = "v1";

const keyCache = new Map<string, Buffer>();

function encryptionKey(info: string): Buffer {
  const cached = keyCache.get(info);
  if (cached) return cached;
  const root = process.env.SESSION_SECRET?.trim();
  if (!root) {
    throw new Error("SESSION_SECRET is required to encrypt stored credentials");
  }
  const key = Buffer.from(
    crypto.hkdfSync(
      "sha256",
      Buffer.from(root, "utf8"),
      Buffer.alloc(0),
      info,
      32,
    ),
  );
  keyCache.set(info, key);
  return key;
}

export function encryptSecret(plaintext: string, info: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(info), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64"),
    tag.toString("base64"),
    ct.toString("base64"),
  ].join(".");
}

export function decryptSecret(
  payload: string | null,
  info: string,
): string | null {
  if (!payload) return null;
  const [version, ivB64, tagB64, ctB64] = payload.split(".");
  if (version !== VERSION || !ivB64 || !tagB64 || !ctB64) return null;

  try {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      encryptionKey(info),
      Buffer.from(ivB64, "base64"),
    );
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(ctB64, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // Wrong key or tampered ciphertext.
    return null;
  }
}

/** Quo API key helpers — INFO label is stable for existing stored keys. */
const QUO_INFO = "bookmycleaning:quo-api-key:v1";
export const encryptQuoKey = (key: string) => encryptSecret(key, QUO_INFO);
export const decryptQuoKey = (payload: string | null) =>
  decryptSecret(payload, QUO_INFO);

/** Jobber OAuth token helpers */
const JOBBER_INFO = "bookmycleaning:jobber-token:v1";
export const encryptJobberToken = (token: string) =>
  encryptSecret(token, JOBBER_INFO);
export const decryptJobberToken = (payload: string | null) =>
  decryptSecret(payload, JOBBER_INFO);

/** Last four characters, for showing which key is connected without leaking it. */
export function maskKey(key: string): string {
  return key.length <= 4 ? "****" : `****${key.slice(-4)}`;
}
