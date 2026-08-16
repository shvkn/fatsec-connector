function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function loadConfig() {
  const nodeEnv = process.env.NODE_ENV || "development";
  const port = Number(process.env.PORT || 8080);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  return {
    nodeEnv,
    isProduction: nodeEnv === "production",
    port,
    publicUrl: required("PUBLIC_URL").replace(/\/$/, ""),
    databaseUrl: required("DATABASE_URL"),
    databaseSsl: process.env.DATABASE_SSL === "true",
    databaseCaCert: process.env.DATABASE_CA_CERT?.replace(/\\n/g, "\n") || undefined,
    fatsecretConsumerKey: required("FATSECRET_CONSUMER_KEY"),
    fatsecretConsumerSecret: required("FATSECRET_CONSUMER_SECRET"),
    tokenEncryptionKey: required("TOKEN_ENCRYPTION_KEY"),
    sessionSecret: required("SESSION_SECRET"),
    adminPassword: required("ADMIN_PASSWORD")
  };
}
