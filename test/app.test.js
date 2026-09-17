import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
import { createSessionManager, createVault } from "../src/security.js";

function startTestApp({ fatsecret: fatsecretOverride } = {}) {
  const vault = createVault(Buffer.alloc(32, 7).toString("base64"));
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
    listAccounts: async () => accounts,
    saveOAuthRequest: async () => {},
    findAccount: async (id) => id === accounts[0].id ? {
      ...accounts[0],
      oauth_token_encrypted: vault.encrypt("access-token"),
      oauth_secret_encrypted: vault.encrypt("access-secret")
    } : null
  };
  const config = {
    adminPassword: "test-password",
    isProduction: false,
    publicUrl: "http://localhost",
    apiKey: "test-api-key"
  };
  const app = createApp({
    config,
    database,
    fatsecret: fatsecretOverride || {},
    vault,
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

test("connector API requires a key and returns normalized search results", async (context) => {
  const fatsecret = {
    searchFoods: async (query, options, credentials) => {
      assert.equal(query, "chicken");
      assert.equal(options.maxResults, 5);
      assert.equal(credentials.token, "access-token");
      return { foods: { page_number: "0", max_results: "5", total_results: "1", food: {
        food_id: "1641",
        food_name: "Chicken Breast",
        food_type: "Generic",
        food_description: "Per 100 g - 195 kcal"
      } } };
    }
  };
  const { server, baseUrl } = await startTestApp({ fatsecret });
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const unauthorized = await fetch(`${baseUrl}/v1/foods/search?query=chicken`);
  assert.equal(unauthorized.status, 401);

  const response = await fetch(`${baseUrl}/v1/foods/search?query=chicken&maxResults=5`, {
    headers: { "x-api-key": "test-api-key" }
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.foods[0].foodId, "1641");
  assert.equal(payload.foods[0].name, "Chicken Breast");
});

test("batch diary endpoint validates all items before writing and creates each entry", async (context) => {
  const calls = [];
  const fatsecret = {
    createFoodEntry: async (entry) => {
      calls.push(entry);
      return { food_entry: { food_entry_id: String(calls.length), food_entry_name: entry.name } };
    }
  };
  const { server, baseUrl } = await startTestApp({ fatsecret });
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const invalid = await fetch(`${baseUrl}/v1/diary/entries`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "test-api-key" },
    body: JSON.stringify({ meal: "dinner", items: [{ foodId: "1641", servingId: "0", numberOfUnits: 1, name: "Invalid serving" }] })
  });
  assert.equal(invalid.status, 400);
  assert.equal(calls.length, 0);

  const response = await fetch(`${baseUrl}/v1/diary/entries`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test-api-key" },
    body: JSON.stringify({
      date: "2026-09-17",
      meal: "dinner",
      items: [
        { foodId: "1641", servingId: "50321", numberOfUnits: 2.5, name: "Chicken breast" },
        { foodId: "36421", servingId: "123", numberOfUnits: 1, name: "Mushrooms" }
      ]
    })
  });
  assert.equal(response.status, 201);
  const payload = await response.json();
  assert.equal(payload.created.length, 2);
  assert.equal(calls[0].meal, "dinner");
  assert.equal(calls[0].date, 20713);
});

test("OpenAPI and plugin manifest are public and point to the configured server", async (context) => {
  const { server, baseUrl } = await startTestApp();
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const schema = await (await fetch(`${baseUrl}/openapi.json`)).json();
  assert.equal(schema.openapi, "3.1.0");
  assert.ok(schema.paths["/v1/diary/entries"]);
  assert.ok(schema.components.securitySchemes.ApiKey);

  const manifest = await (await fetch(`${baseUrl}/.well-known/ai-plugin.json`)).json();
  assert.equal(manifest.api.url, "http://localhost/openapi.json");
});

test("OAuth start requires an admin session and redirects to FatSecret", async (context) => {
  let callbackUrl;
  const fatsecret = {
    requestToken: async (value) => {
      callbackUrl = value;
      return { oauth_token: "request-token", oauth_token_secret: "request-secret" };
    },
    authorizeUrl: (token) => `https://authentication.fatsecret.com/oauth/authorize?oauth_token=${token}`
  };
  const { server, baseUrl } = await startTestApp({ fatsecret });
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const unauthorized = await fetch(`${baseUrl}/auth/start`, { redirect: "manual" });
  assert.equal(unauthorized.status, 401);

  const login = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "test-password" })
  });
  const cookie = login.headers.getSetCookie()[0].split(";", 1)[0];
  const response = await fetch(`${baseUrl}/auth/start`, { headers: { cookie }, redirect: "manual" });
  assert.equal(response.status, 302);
  assert.match(response.headers.get("location"), /authentication\.fatsecret\.com/);
  assert.equal(callbackUrl, "http://localhost/auth/callback");
});
