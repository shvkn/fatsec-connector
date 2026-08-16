import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
import { createSessionManager, createVault } from "../src/security.js";

function startTestApp() {
  const accounts = [{
    id: "3d52cc7a-aa65-4be4-ae70-39803d136a31",
    label: "Личный",
    profile: { last_weight_kg: "72.5" },
    diary_snapshot: { totals: { calories: 1400 } },
    created_at: new Date().toISOString(),
    last_synced_at: new Date().toISOString()
  }];
  const database = {
    ping: async () => {},
    listAccounts: async () => accounts
  };
  const config = {
    adminPassword: "test-password",
    isProduction: false,
    publicUrl: "http://localhost"
  };
  const app = createApp({
    config,
    database,
    fatsecret: {},
    vault: createVault(Buffer.alloc(32, 7).toString("base64")),
    sessions: createSessionManager("test-session-secret")
  });
  const server = app.listen(0, "127.0.0.1");
  return new Promise((resolve) => server.once("listening", () => {
    const { port } = server.address();
    resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
  }));
}

test("management API requires login and returns accounts after login", async (context) => {
  const { server, baseUrl } = await startTestApp();
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const unauthorized = await fetch(`${baseUrl}/api/accounts`);
  assert.equal(unauthorized.status, 401);

  const login = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "test-password" })
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie()[0].split(";", 1)[0];
  const session = await login.json();
  assert.ok(session.csrfToken);

  const response = await fetch(`${baseUrl}/api/accounts`, { headers: { cookie } });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.accounts[0].label, "Личный");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
});

test("login rejects an incorrect password", async (context) => {
  const { server, baseUrl } = await startTestApp();
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "wrong" })
  });
  assert.equal(response.status, 401);
});
