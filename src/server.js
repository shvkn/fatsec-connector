import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDatabase } from "./database.js";
import { FatSecretClient } from "./fatsecret.js";
import { createSessionManager, createVault } from "./security.js";

const config = loadConfig();
const database = createDatabase({
  connectionString: config.databaseUrl,
  ssl: config.databaseSsl,
  ca: config.databaseCaCert
});
const vault = createVault(config.tokenEncryptionKey);
const sessions = createSessionManager(config.sessionSecret);
const fatsecret = new FatSecretClient({
  consumerKey: config.fatsecretConsumerKey,
  consumerSecret: config.fatsecretConsumerSecret
});

await database.migrate();

const app = createApp({ config, database, fatsecret, vault, sessions });
const server = app.listen(config.port, "0.0.0.0", () => {
  console.log(`FatSecret Account Hub is listening on port ${config.port}`);
});

async function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  server.close(async () => {
    await database.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
