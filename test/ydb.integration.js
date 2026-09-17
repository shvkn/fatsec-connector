import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createDatabase } from "../src/database.js";

const connectionString = process.env.YDB_CONNECTION_STRING || "grpc://localhost:2136/local";
const database = createDatabase({ connectionString, authMode: "anonymous" });
const id = crypto.randomUUID();
const oauthToken = `oauth-${crypto.randomUUID()}`;

try {
  await database.migrate();
  await database.ping();

  await database.saveAccount({
    id,
    label: "Интеграционный тест",
    oauthTokenEncrypted: "encrypted-token",
    oauthSecretEncrypted: "encrypted-secret",
    profile: { last_weight_kg: "72.5" },
    diarySnapshot: { totals: { calories: 1400 } }
  });

  const saved = await database.findAccount(id);
  assert.equal(saved.label, "Интеграционный тест");
  assert.equal(saved.profile.last_weight_kg, "72.5");

  await database.updateSnapshot(id, { goal_weight_kg: "70" }, { totals: { calories: 1500 } });
  const updated = await database.findAccount(id);
  assert.equal(updated.profile.goal_weight_kg, "70");
  assert.equal(updated.diary_snapshot.totals.calories, 1500);

  const accounts = await database.listAccounts();
  assert.ok(accounts.some((account) => account.id === id));

  await database.saveOAuthRequest({
    token: oauthToken,
    secretEncrypted: "request-secret",
    label: "Интеграционный тест",
    sessionHash: "session-hash"
  });
  const request = await database.consumeOAuthRequest(oauthToken);
  assert.equal(request.account_label, "Интеграционный тест");
  assert.equal(await database.consumeOAuthRequest(oauthToken), null);

  assert.equal(await database.deleteAccount(id), true);
  assert.equal(await database.deleteAccount(id), false);
  console.log("YDB integration test passed");
} finally {
  await database.close();
}
