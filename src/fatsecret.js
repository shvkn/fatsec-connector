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
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params)
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
    const response = await this.fetch(`${ACCESS_TOKEN_URL}?${new URLSearchParams(params)}`);
    const result = parseForm(await readResponse(response));
    if (!result.oauth_token || !result.oauth_token_secret) {
      throw new Error("FatSecret did not return a valid access token");
    }
    return result;
  }

  async delegatedRequest(method, path, parameters, { token, tokenSecret }) {
    const url = `${REST_BASE_URL}${path}`;
    const requestParams = { format: "json", ...parameters };
    const params = oauthParams(this.consumerKey, { oauth_token: token });
    params.oauth_signature = oauthSignature({
      method,
      url,
      params: { ...params, ...requestParams },
      consumerSecret: this.consumerSecret,
      tokenSecret
    });

    const allParams = { ...requestParams, ...params };
    const response = method === "GET"
      ? await this.fetch(`${url}?${new URLSearchParams(allParams)}`)
      : await this.fetch(url, {
        method,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(allParams)
      });
    return readResponse(response);
  }

  delegatedGet(path, query, credentials) {
    return this.delegatedRequest("GET", path, query, credentials);
  }

  delegatedPost(path, body, credentials) {
    return this.delegatedRequest("POST", path, body, credentials);
  }

  getProfile(credentials) {
    return this.delegatedGet("/profile/v1", {}, credentials);
  }

  getFoodDiary(date, credentials) {
    return this.delegatedGet("/food-entries/v2", { date: String(date) }, credentials);
  }

  searchFoods(searchExpression, { pageNumber = 0, maxResults = 10 } = {}, credentials) {
    return this.delegatedGet("/foods/search/v1", {
      search_expression: searchExpression,
      page_number: String(pageNumber),
      max_results: String(maxResults)
    }, credentials);
  }

  getFood(foodId, credentials) {
    return this.delegatedGet("/food/v5", { food_id: String(foodId) }, credentials);
  }

  createFoodEntry(entry, credentials) {
    return this.delegatedPost("/food-entries/v1", {
      food_id: String(entry.foodId),
      food_entry_name: entry.name,
      serving_id: String(entry.servingId),
      number_of_units: String(entry.numberOfUnits),
      meal: entry.meal,
      date: String(entry.date)
    }, credentials);
  }
}

export function currentFatSecretDay(now = Date.now()) {
  return Math.floor(now / 86_400_000);
}

export function fatSecretDay(value) {
  if (value === undefined || value === null || value === "") return currentFatSecretDay();
  if (Number.isInteger(value) && value >= 0) return value;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("date must be YYYY-MM-DD or a non-negative FatSecret day number");
  }
  const [year, month, day] = value.split("-").map(Number);
  const timestamp = Date.UTC(year, month - 1, day);
  const parsed = new Date(timestamp);
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new Error("date is not a valid calendar date");
  }
  return Math.floor(timestamp / 86_400_000);
}
