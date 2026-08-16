import crypto from "node:crypto";
import express from "express";
import { currentFatSecretDay } from "./fatsecret.js";
import { parseCookies, verifyPassword } from "./security.js";

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

  app.get("/health", asyncRoute(async (_request, response) => {
    await database.ping();
    response.json({ status: "ok" });
  }));

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
    if (label.length < 2 || label.length > 80) {
      return response.status(400).json({ error: "Название должно содержать от 2 до 80 символов" });
    }
    const callbackUrl = `${config.publicUrl}/api/fatsecret/callback`;
    const requestToken = await fatsecret.requestToken(callbackUrl);
    await database.saveOAuthRequest({
      token: requestToken.oauth_token,
      secretEncrypted: vault.encrypt(requestToken.oauth_token_secret),
      label,
      sessionHash: sessions.hashNonce(request.session.nonce)
    });
    response.json({ authorizationUrl: fatsecret.authorizeUrl(requestToken.oauth_token) });
  }));

  app.get("/api/fatsecret/callback", requireSession, asyncRoute(async (request, response) => {
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
    const credentials = {
      token: access.oauth_token,
      tokenSecret: access.oauth_token_secret
    };
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
    response.redirect("/?oauth=connected");
  }));

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

  app.use(express.static(new URL("../public", import.meta.url).pathname, {
    etag: true,
    maxAge: config.isProduction ? "1h" : 0
  }));

  app.use((error, request, response, _next) => {
    console.error(error);
    const message = config.isProduction ? "Внутренняя ошибка сервера" : error.message;
    if (request.path.startsWith("/api/")) return response.status(500).json({ error: message });
    response.status(500).send(message);
  });

  return app;
}
