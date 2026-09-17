import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAccount } from "../src/database.js";

test("YDB account rows are converted to API-safe values", () => {
  const account = normalizeAccount({
    id: "account-id",
    label: "Личный",
    oauth_token_encrypted: "token",
    oauth_secret_encrypted: "secret",
    profile: '{"last_weight_kg":"72.5"}',
    diary_snapshot: '{"totals":{"calories":1400}}',
    created_at: 1_700_000_000_000n,
    updated_at: 1_700_000_000_100n,
    last_synced_at: 1_700_000_000_200n
  });

  assert.equal(account.label, "Личный");
  assert.equal(account.profile.last_weight_kg, "72.5");
  assert.equal(account.diary_snapshot.totals.calories, 1400);
  assert.equal(account.created_at, "2023-11-14T22:13:20.000Z");
});
