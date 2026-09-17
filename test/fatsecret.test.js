import assert from "node:assert/strict";
import test from "node:test";
import { FatSecretClient, currentFatSecretDay, fatSecretDay, oauthSignature, percentEncode } from "../src/fatsecret.js";

test("OAuth encoding follows RFC 3986", () => {
  assert.equal(percentEncode("Ladies + Gentlemen"), "Ladies%20%2B%20Gentlemen");
  assert.equal(percentEncode("!*'()"), "%21%2A%27%28%29");
});

test("OAuth signature matches the OAuth 1.0 specification example", () => {
  const signature = oauthSignature({
    method: "GET",
    url: "http://photos.example.net/photos",
    params: {
      file: "vacation.jpg",
      size: "original",
      oauth_consumer_key: "dpf43f3p2l4k3l03",
      oauth_token: "nnch734d00sl2jdk",
      oauth_nonce: "kllo9940pd9333jh",
      oauth_timestamp: "1191242096",
      oauth_signature_method: "HMAC-SHA1",
      oauth_version: "1.0"
    },
    consumerSecret: "kd94hf93k423kf44",
    tokenSecret: "pfkkdhi9sl3r4s00"
  });
  assert.equal(signature, "tR3+Ty81lMeYAr/Fid0kMTYa/WM=");
});

test("FatSecret date is expressed as days since Unix epoch", () => {
  assert.equal(currentFatSecretDay(Date.UTC(1970, 0, 2)), 1);
  assert.equal(fatSecretDay("1970-01-02"), 1);
  assert.throws(() => fatSecretDay("2026-02-30"), /valid calendar date/);
});

test("diary entry is signed and sent as a POST form", async () => {
  const client = new FatSecretClient({
    consumerKey: "consumer-key",
    consumerSecret: "consumer-secret",
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://platform.fatsecret.com/rest/food-entries/v1");
      assert.equal(options.method, "POST");
      const body = new URLSearchParams(options.body);
      assert.equal(body.get("food_id"), "1641");
      assert.equal(body.get("serving_id"), "50321");
      assert.equal(body.get("number_of_units"), "2.5");
      assert.equal(body.get("meal"), "dinner");
      assert.equal(body.get("date"), "20713");
      assert.equal(body.get("oauth_token"), "access-token");
      assert.ok(body.get("oauth_signature"));
      return Response.json({ food_entry: { food_entry_id: "1" } });
    }
  });

  const result = await client.createFoodEntry({
    foodId: "1641",
    servingId: "50321",
    numberOfUnits: 2.5,
    name: "Chicken breast",
    meal: "dinner",
    date: 20713
  }, { token: "access-token", tokenSecret: "access-secret" });
  assert.equal(result.food_entry.food_entry_id, "1");
});

test("request token parameters are sent as a form body", async () => {
  const client = new FatSecretClient({
    consumerKey: "consumer-key",
    consumerSecret: "consumer-secret",
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://authentication.fatsecret.com/oauth/request_token");
      assert.equal(options.method, "POST");
      assert.equal(options.headers["content-type"], "application/x-www-form-urlencoded");
      const body = new URLSearchParams(options.body);
      assert.equal(body.get("oauth_consumer_key"), "consumer-key");
      assert.equal(body.get("oauth_callback"), "https://example.com/callback");
      assert.ok(body.get("oauth_signature"));
      return new Response("oauth_token=request-token&oauth_token_secret=request-secret&oauth_callback_confirmed=true");
    }
  });

  const result = await client.requestToken("https://example.com/callback");
  assert.equal(result.oauth_token, "request-token");
});

test("access and delegated OAuth parameters are sent in GET query strings", async () => {
  const requests = [];
  const client = new FatSecretClient({
    consumerKey: "consumer-key",
    consumerSecret: "consumer-secret",
    fetchImpl: async (url) => {
      requests.push(new URL(url));
      if (url.startsWith("https://authentication.fatsecret.com/oauth/access_token")) {
        return new Response("oauth_token=access-token&oauth_token_secret=access-secret");
      }
      return Response.json({ profile: { id: "profile-id" } });
    }
  });

  const access = await client.accessToken({
    requestToken: "request-token",
    requestSecret: "request-secret",
    verifier: "verifier"
  });
  assert.equal(access.oauth_token, "access-token");
  assert.equal(requests[0].searchParams.get("oauth_consumer_key"), "consumer-key");
  assert.equal(requests[0].searchParams.get("oauth_token"), "request-token");
  assert.ok(requests[0].searchParams.get("oauth_signature"));

  await client.getProfile({ token: "access-token", tokenSecret: "access-secret" });
  assert.equal(requests[1].searchParams.get("format"), "json");
  assert.equal(requests[1].searchParams.get("oauth_token"), "access-token");
  assert.ok(requests[1].searchParams.get("oauth_signature"));
});
