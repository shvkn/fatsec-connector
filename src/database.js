import { AnonymousCredentialsProvider } from "@ydbjs/auth/anonymous";
import { MetadataCredentialsProvider } from "@ydbjs/auth/metadata";
import { Driver } from "@ydbjs/core";
import { query } from "@ydbjs/query";
import { Uint64 } from "@ydbjs/value/primitive";

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

function json(value) {
  return JSON.stringify(value ?? null);
}

function parseJson(value) {
  return value ? JSON.parse(value) : null;
}

function timestamp(value) {
  return new Uint64(BigInt(value));
}

export function normalizeAccount(row) {
  if (!row) return null;
  return {
    id: row.id,
    label: row.label,
    oauth_token_encrypted: row.oauth_token_encrypted,
    oauth_secret_encrypted: row.oauth_secret_encrypted,
    profile: parseJson(row.profile),
    diary_snapshot: parseJson(row.diary_snapshot),
    created_at: new Date(Number(row.created_at)).toISOString(),
    updated_at: new Date(Number(row.updated_at)).toISOString(),
    last_synced_at: row.last_synced_at == null
      ? null
      : new Date(Number(row.last_synced_at)).toISOString()
  };
}

function credentialsProvider(authMode) {
  if (authMode === "metadata") return new MetadataCredentialsProvider();
  return new AnonymousCredentialsProvider();
}

export function createDatabase({ connectionString, authMode = "anonymous" }) {
  const driver = new Driver(connectionString, {
    credentialsProvider: credentialsProvider(authMode),
    "ydb.sdk.application": "fatsecret-account-hub"
  });
  const sql = query(driver);

  return {
    async migrate() {
      await driver.ready();
      await sql`
        CREATE TABLE IF NOT EXISTS fatsecret_accounts (
          id Text NOT NULL,
          label Text NOT NULL,
          oauth_token_encrypted Text NOT NULL,
          oauth_secret_encrypted Text NOT NULL,
          profile Text,
          diary_snapshot Text,
          created_at Uint64 NOT NULL,
          updated_at Uint64 NOT NULL,
          last_synced_at Uint64,
          PRIMARY KEY (id)
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS oauth_requests (
          oauth_token Text NOT NULL,
          oauth_secret_encrypted Text NOT NULL,
          account_label Text NOT NULL,
          session_hash Text NOT NULL,
          created_at Uint64 NOT NULL,
          PRIMARY KEY (oauth_token)
        )
      `;
    },

    async ping() {
      await sql`SELECT 1 AS ok`;
    },

    async listAccounts() {
      const [rows] = await sql`
        SELECT id, label, profile, diary_snapshot, created_at, updated_at, last_synced_at
        FROM fatsecret_accounts
        ORDER BY created_at DESC
      `;
      return rows.map(normalizeAccount);
    },

    async findAccount(id) {
      const [rows] = await sql`
        SELECT id, label, oauth_token_encrypted, oauth_secret_encrypted,
          profile, diary_snapshot, created_at, updated_at, last_synced_at
        FROM fatsecret_accounts
        WHERE id = ${id}
      `;
      return normalizeAccount(rows[0]);
    },

    async saveAccount(account) {
      const now = Date.now();
      await sql`
        UPSERT INTO fatsecret_accounts (
          id, label, oauth_token_encrypted, oauth_secret_encrypted, profile,
          diary_snapshot, created_at, updated_at, last_synced_at
        ) VALUES (
          ${account.id}, ${account.label}, ${account.oauthTokenEncrypted},
          ${account.oauthSecretEncrypted}, ${json(account.profile)},
          ${json(account.diarySnapshot)}, ${timestamp(now)}, ${timestamp(now)},
          ${timestamp(now)}
        )
      `;
    },

    async updateSnapshot(id, profile, diarySnapshot) {
      const now = Date.now();
      await sql`
        UPDATE fatsecret_accounts
        SET profile = ${json(profile)}, diary_snapshot = ${json(diarySnapshot)},
          updated_at = ${timestamp(now)}, last_synced_at = ${timestamp(now)}
        WHERE id = ${id}
      `;
    },

    async deleteAccount(id) {
      const [rows] = await sql`
        DELETE FROM fatsecret_accounts
        WHERE id = ${id}
        RETURNING id
      `;
      return rows.length > 0;
    },

    async saveOAuthRequest(request) {
      const cutoff = Date.now() - FIFTEEN_MINUTES_MS;
      await sql`DELETE FROM oauth_requests WHERE created_at < ${timestamp(cutoff)}`;
      await sql`
        UPSERT INTO oauth_requests (
          oauth_token, oauth_secret_encrypted, account_label, session_hash, created_at
        ) VALUES (
          ${request.token}, ${request.secretEncrypted}, ${request.label},
          ${request.sessionHash}, ${timestamp(Date.now())}
        )
      `;
    },

    async consumeOAuthRequest(token) {
      const cutoff = Date.now() - FIFTEEN_MINUTES_MS;
      const [rows] = await sql`
        DELETE FROM oauth_requests
        WHERE oauth_token = ${token} AND created_at >= ${timestamp(cutoff)}
        RETURNING oauth_token, oauth_secret_encrypted, account_label, session_hash, created_at
      `;
      return rows[0] || null;
    },

    async close() {
      await sql[Symbol.asyncDispose]();
      driver.close();
    }
  };
}
