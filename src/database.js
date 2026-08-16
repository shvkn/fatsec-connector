import fs from "node:fs/promises";
import pg from "pg";

const { Pool } = pg;

export function createDatabase({ connectionString, ssl = false, ca }) {
  const pool = new Pool({
    connectionString,
    max: 8,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ssl: ssl ? { rejectUnauthorized: true, ...(ca ? { ca } : {}) } : false
  });

  return {
    async migrate() {
      const sql = await fs.readFile(new URL("../sql/001_init.sql", import.meta.url), "utf8");
      await pool.query(sql);
    },

    async ping() {
      await pool.query("SELECT 1");
    },

    async listAccounts() {
      const result = await pool.query(`
        SELECT id, label, profile, diary_snapshot, created_at, updated_at, last_synced_at
        FROM fatsecret_accounts
        ORDER BY created_at DESC
      `);
      return result.rows;
    },

    async findAccount(id) {
      const result = await pool.query("SELECT * FROM fatsecret_accounts WHERE id = $1", [id]);
      return result.rows[0] || null;
    },

    async saveAccount(account) {
      await pool.query(`
        INSERT INTO fatsecret_accounts (
          id, label, oauth_token_encrypted, oauth_secret_encrypted, profile, diary_snapshot,
          last_synced_at
        ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
        ON CONFLICT (id) DO UPDATE SET
          label = EXCLUDED.label,
          oauth_token_encrypted = EXCLUDED.oauth_token_encrypted,
          oauth_secret_encrypted = EXCLUDED.oauth_secret_encrypted,
          profile = EXCLUDED.profile,
          diary_snapshot = EXCLUDED.diary_snapshot,
          updated_at = NOW(),
          last_synced_at = NOW()
      `, [
        account.id,
        account.label,
        account.oauthTokenEncrypted,
        account.oauthSecretEncrypted,
        account.profile,
        account.diarySnapshot
      ]);
    },

    async updateSnapshot(id, profile, diarySnapshot) {
      await pool.query(`
        UPDATE fatsecret_accounts
        SET profile = $2, diary_snapshot = $3, updated_at = NOW(), last_synced_at = NOW()
        WHERE id = $1
      `, [id, profile, diarySnapshot]);
    },

    async deleteAccount(id) {
      const result = await pool.query("DELETE FROM fatsecret_accounts WHERE id = $1", [id]);
      return result.rowCount > 0;
    },

    async saveOAuthRequest(request) {
      await pool.query("DELETE FROM oauth_requests WHERE created_at < NOW() - INTERVAL '15 minutes'");
      await pool.query(`
        INSERT INTO oauth_requests (
          oauth_token, oauth_secret_encrypted, account_label, session_hash
        ) VALUES ($1, $2, $3, $4)
      `, [request.token, request.secretEncrypted, request.label, request.sessionHash]);
    },

    async consumeOAuthRequest(token) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await client.query(`
          DELETE FROM oauth_requests
          WHERE oauth_token = $1 AND created_at >= NOW() - INTERVAL '15 minutes'
          RETURNING *
        `, [token]);
        await client.query("COMMIT");
        return result.rows[0] || null;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async close() {
      await pool.end();
    }
  };
}
