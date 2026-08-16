import assert from "node:assert/strict";
import test from "node:test";
import { currentFatSecretDay, oauthSignature, percentEncode } from "../src/fatsecret.js";

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
});
