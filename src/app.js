import crypto from "node:crypto";
import express from "express";
import { currentFatSecretDay, fatSecretDay } from "./fatsecret.js";
import { openApiDocument, pluginManifest } from "./openapi.js";
import { parseCookies, verifyApiKey, verifyPassword } from "./security.js";

const COOKIE_NAME = "fsh_session";

function asyncRoute(handler) {
  return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);
}

function summarizeDiary(payload) {
  const rawEntries = payload?.food_entries?.food_entry || [];
  const entries = Array.isArray(rawEntries) ? rawEntries : [rawEntries];
  return {
    entries: entries.map((entry) => ({
      id: entry.food_entry_id,
      name: entry.food_entry_name,
      meal: entry.meal,
      calories: Number(entry.calories || 0),
      protein: Number(entry.protein || 0),
      carbohydrate: Number(entry.carbohydrate || 0),
      fat: Number(entry.fat || 0)
    })),
    totals: entries.reduce((totals, entry) => ({
      calories: totals.calories + Number(entry.calories || 0),
      protein: totals.protein + Number(entry.protein || 0),
      carbohydrate: totals.carbohydrate + Number(entry.carbohydrate || 0),
      fat: totals.fat + Number(entry.fat || 0)
    }), { calories: 0, protein: 0, carbohydrate: 0, fat: 0 })
  };
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeFoodSearch(payload) {
  const result = payload?.foods || payload?.foods_search || {};
  return {
    page: Number(result.page_number || 0),
    maxResults: Number(result.max_results || 0),
    totalResults: Number(result.total_results || 0),
    foods: asArray(result.food).map((food) => ({
      foodId: String(food.food_id),
      name: food.food_name,
      brandName: food.brand_name || null,
      type: food.food_type,
      description: food.food_description,
      url: food.food_url
    }))
  };
}

function normalizeFood(payload) {
  const food = payload?.food || payload || {};
  return {
    foodId: String(food.food_id),
    name: food.food_name,
    brandName: food.brand_name || null,
    type: food.food_type,
    url: food.food_url,
    servings: asArray(food.servings?.serving).map((serving) => ({
      servingId: String(serving.serving_id),
      canLog: String(serving.serving_id) !== "0",
      description: serving.serving_description,
      numberOfUnits: Number(serving.number_of_units),
      metricAmount: serving.metric_serving_amount == null ? null : Number(serving.metric_serving_amount),
      metricUnit: serving.metric_serving_unit || null,
      calories: Number(serving.calories || 0),
      protein: Number(serving.protein || 0),
      carbohydrate: Number(serving.carbohydrate || 0),
      fat: Number(serving.fat || 0)
    }))
  };
}

function validateDiaryRequest(body) {
  const meals = new Set(["breakfast", "lunch", "dinner", "other"]);
  if (!body || typeof body !== "object" || Array.isArray(body)) return "body must be a JSON object";
  if (!meals.has(body.meal)) return "meal must be breakfast, lunch, dinner, or other";
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 20) {
    return "items must contain between 1 and 20 entries";
  }
  for (const [index, item] of body.items.entries()) {
    if (!item || typeof item !== "object") return `items[${index}] must be an object`;
    if (!/^\d+$/.test(String(item.foodId || ""))) return `items[${index}].foodId must be a numeric ID`;
    if (!/^[1-9]\d*$/.test(String(item.servingId || ""))) return `items[${index}].servingId must be a non-zero numeric ID`;
    if (!Number.isFinite(item.numberOfUnits) || item.numberOfUnits <= 0 || item.numberOfUnits > 10_000) {
      return `items[${index}].numberOfUnits must be greater than 0 and at most 10000`;
    }
    if (typeof item.name !== "string" || item.name.trim().length < 1 || item.name.trim().length > 200) {
      return `items[${index}].name must contain between 1 and 200 characters`;
    }
  }
  return null;
}

export function createApp({ config, database, fatsecret, vault, sessions }) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "20kb" }));

  app.use((request, response, next) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "same-origin");
    response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    response.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self' https://authentication.fatsecret.com");
    next();
  });

  function sessionFor(request) {
    return sessions.read(parseCookies(request.headers.cookie)[COOKIE_NAME]);
  }

  function requireSession(request, response, next) {
    const session = sessionFor(request);
    if (!session) return response.status(401).json({ error: "Требуется вход" });
    request.session = session;
    next();
  }

  function requireCsrf(request, response, next) {
    if (request.headers["x-csrf-token"] !== request.session.csrf) {
      return response.status(403).json({ error: "Некорректный CSRF-токен" });
    }
    next();
  }

  function requireApiKey(request, response, next) {
    const authorization = request.headers.authorization || "";
    const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    const supplied = request.headers["x-api-key"] || bearer;
    if (!verifyApiKey(supplied, config.apiKey)) {
      response.setHeader("WWW-Authenticate", "Bearer");
      return response.status(401).json({ error: "Invalid or missing API key" });
    }
    next();
  }

  async function accountCredentials(accountId) {
    let account;
    if (accountId) {
      account = await database.findAccount(String(accountId));
    } else {
      const accounts = await database.listAccounts();
      if (accounts.length > 1) return { requiresAccountId: true };
      const [first] = accounts;
      if (first) account = await database.findAccount(first.id);
    }
    if (!account) return null;
    return {
      account,
      credentials: {
        token: vault.decrypt(account.oauth_token_encrypted),
        tokenSecret: vault.decrypt(account.oauth_secret_encrypted)
      }
    };
  }

  async function beginOAuth(label, session) {
    if (label.length < 2 || label.length > 80) return null;
    const callbackUrl = `${config.publicUrl}/auth/callback`;
    const requestToken = await fatsecret.requestToken(callbackUrl);
    await database.saveOAuthRequest({
      token: requestToken.oauth_token,
      secretEncrypted: vault.encrypt(requestToken.oauth_token_secret),
      label,
      sessionHash: sessions.hashNonce(session.nonce)
    });
    return fatsecret.authorizeUrl(requestToken.oauth_token);
  }

  async function finishOAuth(request, response) {
    const token = String(request.query.oauth_token || "");
    const verifier = String(request.query.oauth_verifier || "");
    if (!token || !verifier) return response.redirect("/?oauth=denied");

    const pending = await database.consumeOAuthRequest(token);
    if (!pending || pending.session_hash !== sessions.hashNonce(request.session.nonce)) {
      return response.redirect("/?oauth=expired");
    }
    const access = await fatsecret.accessToken({
      requestToken: token,
      requestSecret: vault.decrypt(pending.oauth_secret_encrypted),
      verifier
    });
    const credentials = { token: access.oauth_token, tokenSecret: access.oauth_token_secret };
    const [profilePayload, diaryPayload] = await Promise.all([
      fatsecret.getProfile(credentials),
      fatsecret.getFoodDiary(currentFatSecretDay(), credentials)
    ]);
    await database.saveAccount({
      id: crypto.randomUUID(),
      label: pending.account_label,
      oauthTokenEncrypted: vault.encrypt(credentials.token),
      oauthSecretEncrypted: vault.encrypt(credentials.tokenSecret),
      profile: profilePayload.profile || profilePayload,
      diarySnapshot: summarizeDiary(diaryPayload)
    });
    return response.redirect("/?oauth=connected");
  }

  app.get("/health", asyncRoute(async (_request, response) => {
    await database.ping();
    response.json({ status: "ok", service: "fatsecret-diary-connector" });
  }));

  app.get("/openapi.json", (_request, response) => response.json(openApiDocument(config.publicUrl)));
  app.get("/.well-known/ai-plugin.json", (_request, response) => response.json(pluginManifest(config.publicUrl)));

  app.get("/api/session", (request, response) => {
    const session = sessionFor(request);
    response.json({ authenticated: Boolean(session), csrfToken: session?.csrf || null });
  });

  app.post("/api/login", (request, response) => {
    if (!verifyPassword(request.body?.password || "", config.adminPassword)) {
      return response.status(401).json({ error: "Неверный пароль" });
    }
    const cookie = sessions.create();
    response.cookie(COOKIE_NAME, cookie, {
      httpOnly: true,
      sameSite: "lax",
      secure: config.isProduction,
      maxAge: 12 * 60 * 60 * 1000,
      path: "/"
    });
    const session = sessions.read(cookie);
    response.json({ authenticated: true, csrfToken: session.csrf });
  });

  app.post("/api/logout", requireSession, requireCsrf, (_request, response) => {
    response.clearCookie(COOKIE_NAME, { path: "/" });
    response.status(204).end();
  });

  app.get("/api/accounts", requireSession, asyncRoute(async (_request, response) => {
    response.json({ accounts: await database.listAccounts() });
  }));

  app.post("/api/fatsecret/connect", requireSession, requireCsrf, asyncRoute(async (request, response) => {
    const label = String(request.body?.label || "").trim();
    const authorizationUrl = await beginOAuth(label, request.session);
    if (!authorizationUrl) {
      return response.status(400).json({ error: "Название должно содержать от 2 до 80 символов" });
    }
    response.json({ authorizationUrl });
  }));

  app.get("/auth/start", requireSession, asyncRoute(async (request, response) => {
    const label = String(request.query.label || "Личный аккаунт").trim();
    const authorizationUrl = await beginOAuth(label, request.session);
    if (!authorizationUrl) return response.status(400).json({ error: "Invalid account label" });
    response.redirect(authorizationUrl);
  }));

  app.get("/auth/callback", requireSession, asyncRoute(finishOAuth));
  app.get("/api/fatsecret/callback", requireSession, asyncRoute(finishOAuth));

  app.post("/api/accounts/:id/sync", requireSession, requireCsrf, asyncRoute(async (request, response) => {
    const account = await database.findAccount(request.params.id);
    if (!account) return response.status(404).json({ error: "Аккаунт не найден" });
    const credentials = {
      token: vault.decrypt(account.oauth_token_encrypted),
      tokenSecret: vault.decrypt(account.oauth_secret_encrypted)
    };
    const [profilePayload, diaryPayload] = await Promise.all([
      fatsecret.getProfile(credentials),
      fatsecret.getFoodDiary(currentFatSecretDay(), credentials)
    ]);
    const profile = profilePayload.profile || profilePayload;
    const diary = summarizeDiary(diaryPayload);
    await database.updateSnapshot(account.id, profile, diary);
    response.json({ profile, diary });
  }));

  app.delete("/api/accounts/:id", requireSession, requireCsrf, asyncRoute(async (request, response) => {
    const deleted = await database.deleteAccount(request.params.id);
    response.status(deleted ? 204 : 404).end();
  }));

  app.get("/v1/foods/search", requireApiKey, asyncRoute(async (request, response) => {
    const query = String(request.query.query || "").trim();
    const page = Number(request.query.page || 0);
    const maxResults = Number(request.query.maxResults || 10);
    if (query.length < 2 || query.length > 200) return response.status(400).json({ error: "query must contain between 2 and 200 characters" });
    if (!Number.isInteger(page) || page < 0) return response.status(400).json({ error: "page must be a non-negative integer" });
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 50) return response.status(400).json({ error: "maxResults must be an integer between 1 and 50" });
    const connected = await accountCredentials(request.query.accountId);
    if (connected?.requiresAccountId) return response.status(400).json({ error: "accountId is required when multiple accounts are connected" });
    if (!connected) return response.status(409).json({ error: "No connected FatSecret account" });
    const payload = await fatsecret.searchFoods(query, { pageNumber: page, maxResults }, connected.credentials);
    response.json(normalizeFoodSearch(payload));
  }));

  app.get("/v1/foods/:foodId", requireApiKey, asyncRoute(async (request, response) => {
    if (!/^\d+$/.test(request.params.foodId)) return response.status(400).json({ error: "foodId must be numeric" });
    const connected = await accountCredentials(request.query.accountId);
    if (connected?.requiresAccountId) return response.status(400).json({ error: "accountId is required when multiple accounts are connected" });
    if (!connected) return response.status(409).json({ error: "No connected FatSecret account" });
    response.json(normalizeFood(await fatsecret.getFood(request.params.foodId, connected.credentials)));
  }));

  app.get("/v1/diary", requireApiKey, asyncRoute(async (request, response) => {
    let date;
    try {
      date = fatSecretDay(request.query.date);
    } catch (error) {
      return response.status(400).json({ error: error.message });
    }
    const connected = await accountCredentials(request.query.accountId);
    if (connected?.requiresAccountId) return response.status(400).json({ error: "accountId is required when multiple accounts are connected" });
    if (!connected) return response.status(409).json({ error: "No connected FatSecret account" });
    response.json({ date, ...summarizeDiary(await fatsecret.getFoodDiary(date, connected.credentials)) });
  }));

  app.post("/v1/diary/entries", requireApiKey, asyncRoute(async (request, response) => {
    const validationError = validateDiaryRequest(request.body);
    if (validationError) return response.status(400).json({ error: validationError });
    let date;
    try {
      date = fatSecretDay(request.body.date);
    } catch (error) {
      return response.status(400).json({ error: error.message });
    }
    const connected = await accountCredentials(request.body.accountId);
    if (connected?.requiresAccountId) return response.status(400).json({ error: "accountId is required when multiple accounts are connected" });
    if (!connected) return response.status(409).json({ error: "No connected FatSecret account" });

    const created = [];
    for (const [index, item] of request.body.items.entries()) {
      try {
        const result = await fatsecret.createFoodEntry({
          foodId: item.foodId,
          servingId: item.servingId,
          numberOfUnits: item.numberOfUnits,
          name: item.name.trim(),
          meal: request.body.meal,
          date
        }, connected.credentials);
        created.push(result.food_entry || result);
      } catch (error) {
        console.error(`FatSecret diary batch failed at item ${index}:`, error.message);
        return response.status(502).json({
          error: "FatSecret rejected a diary entry",
          failedItemIndex: index,
          created
        });
      }
    }
    response.status(201).json({ date, meal: request.body.meal, created });
  }));

  app.use(express.static(new URL("../public", import.meta.url).pathname, {
    etag: true,
    maxAge: config.isProduction ? "1h" : 0
  }));

  app.use((error, request, response, _next) => {
    console.error(error);
    const message = config.isProduction ? "Внутренняя ошибка сервера" : error.message;
    if (request.path.startsWith("/api/") || request.path.startsWith("/v1/")) {
      return response.status(500).json({ error: message });
    }
    response.status(500).send(message);
  });

  return app;
}
