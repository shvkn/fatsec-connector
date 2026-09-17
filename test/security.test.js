import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { createSessionManager, createVault, verifyPassword } from "../src/security.js";

test("vault encrypts and decrypts token values", () => {
  const vault = createVault(crypto.randomBytes(32).toString("base64"));
  const encrypted = vault.encrypt("access-token-secret");
  assert.notEqual(encrypted, "access-token-secret");
  assert.equal(vault.decrypt(encrypted), "access-token-secret");
});

test("vault detects encrypted value tampering", () => {
  const vault = createVault(crypto.randomBytes(32).toString("base64"));
  const encrypted = vault.encrypt("secret");
  const parts = encrypted.split(".");
  const ciphertext = Buffer.from(parts[2], "base64url");
  ciphertext[0] ^= 1;
  parts[2] = ciphertext.toString("base64url");
  assert.throws(() => vault.decrypt(parts.join(".")));
});

test("signed sessions can be verified and expose a CSRF token", () => {
  const sessions = createSessionManager("session-secret", { ttlSeconds: 60 });
  const cookie = sessions.create();
  const session = sessions.read(cookie);
  assert.ok(session.nonce);
  assert.ok(session.csrf);
  assert.equal(sessions.read(`${cookie}tampered`), null);
});

test("password comparison works without direct string comparison", () => {
  assert.equal(verifyPassword("correct horse", "correct horse"), true);
  assert.equal(verifyPassword("wrong", "correct horse"), false);
});
