import crypto from "node:crypto";

function decodeEncryptionKey(value) {
  const key = /^[0-9a-f]{64}$/i.test(value)
    ? Buffer.from(value, "hex")
    : Buffer.from(value, "base64");

  if (key.length !== 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes");
  }
  return key;
}

export function createVault(encodedKey) {
  const key = decodeEncryptionKey(encodedKey);

  return {
    encrypt(value) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([
        cipher.update(String(value), "utf8"),
        cipher.final()
      ]);
      const tag = cipher.getAuthTag();
      return [iv, tag, ciphertext].map((part) => part.toString("base64url")).join(".");
    },

    decrypt(payload) {
      const [ivValue, tagValue, ciphertextValue] = String(payload).split(".");
      if (!ivValue || !tagValue || !ciphertextValue) {
        throw new Error("Invalid encrypted value");
      }
      const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(ivValue, "base64url")
      );
      decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertextValue, "base64url")),
        decipher.final()
      ]).toString("utf8");
    }
  };
}

function hmac(secret, value) {
  return crypto.createHmac("sha256", secret).update(value).digest("base64url");
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function verifyPassword(actual, expected) {
  return safeEqual(
    crypto.createHash("sha256").update(String(actual)).digest("hex"),
    crypto.createHash("sha256").update(String(expected)).digest("hex")
  );
}

export function verifyApiKey(actual, expected) {
  if (!actual || !expected) return false;
  return safeEqual(
    crypto.createHash("sha256").update(String(actual)).digest(),
    crypto.createHash("sha256").update(String(expected)).digest()
  );
}

export function createSessionManager(secret, { ttlSeconds = 12 * 60 * 60 } = {}) {
  function read(cookieValue) {
    if (!cookieValue) return null;
    const [expiresValue, nonce, signature] = cookieValue.split(".");
    const unsigned = `${expiresValue}.${nonce}`;
    const expires = Number(expiresValue);
    if (!expires || expires < Math.floor(Date.now() / 1000)) return null;
    if (!signature || !safeEqual(signature, hmac(secret, unsigned))) return null;
    return {
      expires,
      nonce,
      csrf: hmac(secret, `csrf:${nonce}`)
    };
  }

  return {
    create() {
      const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
      const nonce = crypto.randomBytes(24).toString("base64url");
      const unsigned = `${expires}.${nonce}`;
      return `${unsigned}.${hmac(secret, unsigned)}`;
    },
    read,
    hashNonce(nonce) {
      return hmac(secret, `oauth:${nonce}`);
    }
  };
}

export function parseCookies(header = "") {
  return Object.fromEntries(
    header.split(";").map((item) => item.trim()).filter(Boolean).map((item) => {
      const index = item.indexOf("=");
      if (index === -1) return [item, ""];
      return [item.slice(0, index), decodeURIComponent(item.slice(index + 1))];
    })
  );
}
