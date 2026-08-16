import crypto from "node:crypto";

const REQUEST_TOKEN_URL = "https://authentication.fatsecret.com/oauth/request_token";
const AUTHORIZE_URL = "https://authentication.fatsecret.com/oauth/authorize";
const ACCESS_TOKEN_URL = "https://authentication.fatsecret.com/oauth/access_token";
const REST_BASE_URL = "https://platform.fatsecret.com/rest";

export function percentEncode(value) {
  return encodeURIComponent(String(value))
    .replace(/!/g, "%21")
    .replace(/'/g, "%27")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/\*/g, "%2A");
}

export function oauthSignature({ method, url, params, consumerSecret, tokenSecret = "" }) {
  const normalizedParams = Object.entries(params)
    .map(([key, value]) => [percentEncode(key), percentEncode(value)])
    .sort(([aKey, aValue], [bKey, bValue]) => aKey.localeCompare(bKey) || aValue.localeCompare(bValue))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  const signatureBase = [method.toUpperCase(), percentEncode(url), percentEncode(normalizedParams)].join("&");
  const signingKey = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  return crypto.createHmac("sha1", signingKey).update(signatureBase).digest("base64");
}

function oauthParams(consumerKey, extra = {}) {
  return {
    oauth_consumer_key: consumerKey,
    oauth_nonce: crypto.randomBytes(18).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_version: "1.0",
    ...extra
  };
}

function authorizationHeader(params) {
  return `OAuth ${Object.entries(params)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${percentEncode(key)}="${percentEncode(value)}"`)
    .join(", ")}`;
}

function parseForm(body) {
  return Object.fromEntries(new URLSearchParams(body));
}

async function readResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("json") ? await response.json() : await response.text();
  if (!response.ok) {
    const message = typeof body === "string" ? body : JSON.stringify(body);
    throw new Error(`FatSecret returned ${response.status}: ${message}`);
  }
  if (typeof body === "object" && body?.error) {
    throw new Error(`FatSecret API error ${body.error.code}: ${body.error.message}`);
  }
  return body;
}

export class FatSecretClient {
  constructor({ consumerKey, consumerSecret, fetchImpl = globalThis.fetch }) {
    this.consumerKey = consumerKey;
    this.consumerSecret = consumerSecret;
    this.fetch = fetchImpl;
  }

  async requestToken(callbackUrl) {
    const params = oauthParams(this.consumerKey, { oauth_callback: callbackUrl });
    params.oauth_signature = oauthSignature({
      method: "POST",
      url: REQUEST_TOKEN_URL,
      params,
      consumerSecret: this.consumerSecret
    });
    const response = await this.fetch(REQUEST_TOKEN_URL, {
      method: "POST",
      headers: { Authorization: authorizationHeader(params) }
    });
    const result = parseForm(await readResponse(response));
    if (!result.oauth_token || !result.oauth_token_secret || result.oauth_callback_confirmed !== "true") {
      throw new Error("FatSecret did not return a valid request token");
    }
    return result;
  }

  authorizeUrl(requestToken) {
    return `${AUTHORIZE_URL}?oauth_token=${percentEncode(requestToken)}`;
  }

  async accessToken({ requestToken, requestSecret, verifier }) {
    const params = oauthParams(this.consumerKey, {
      oauth_token: requestToken,
      oauth_verifier: verifier
    });
    params.oauth_signature = oauthSignature({
      method: "GET",
      url: ACCESS_TOKEN_URL,
      params,
      consumerSecret: this.consumerSecret,
      tokenSecret: requestSecret
    });
    const response = await this.fetch(ACCESS_TOKEN_URL, {
      headers: { Authorization: authorizationHeader(params) }
    });
    const result = parseForm(await readResponse(response));
    if (!result.oauth_token || !result.oauth_token_secret) {
      throw new Error("FatSecret did not return a valid access token");
    }
    return result;
  }

  async delegatedGet(path, query, { token, tokenSecret }) {
    const url = `${REST_BASE_URL}${path}`;
    const queryParams = { format: "json", ...query };
    const params = oauthParams(this.consumerKey, { oauth_token: token });
    params.oauth_signature = oauthSignature({
      method: "GET",
      url,
      params: { ...params, ...queryParams },
      consumerSecret: this.consumerSecret,
      tokenSecret
    });
    const response = await this.fetch(`${url}?${new URLSearchParams(queryParams)}`, {
      headers: { Authorization: authorizationHeader(params) }
    });
    return readResponse(response);
  }

  getProfile(credentials) {
    return this.delegatedGet("/profile/v1", {}, credentials);
  }

  getFoodDiary(date, credentials) {
    return this.delegatedGet("/food-entries/v2", { date: String(date) }, credentials);
  }
}

export function currentFatSecretDay(now = Date.now()) {
  return Math.floor(now / 86_400_000);
}
