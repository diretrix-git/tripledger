import path from 'path';
import { pathToFileURL } from 'url';
import { createApp } from './app.js';
import { connectDatabase } from './config/database.js';
import { env, validateProductionStartupConfig, type EnvConfig } from './config/env.js';
import { ensureRateLimitIndexes } from './services/rateLimitStore.js';
import { redactSensitiveText } from './utils/redact.js';

export async function bootstrap(
  config: EnvConfig = env,
  deps: {
    connectDb?: () => Promise<void>;
    ensureIndexesFn?: () => Promise<void>;
    createAppFn?: typeof createApp;
  } = {}
): Promise<void> {
  // Validate production email delivery, HTTPS CLIENT_URL, MONGODB_URI, proxy/rate-limit topology, and JWT secrets BEFORE connecting or listening.
  validateProductionStartupConfig(config);
  await (deps.connectDb ? deps.connectDb() : connectDatabase());
  if (config.RATE_LIMIT_STORE === 'mongo') {
    await (deps.ensureIndexesFn ? deps.ensureIndexesFn() : ensureRateLimitIndexes());
  }
  const app = (deps.createAppFn ?? createApp)();
  app.listen(config.PORT, '0.0.0.0', () => {
    console.log(`[TripLedger Server] Running on http://0.0.0.0:${config.PORT}`);
  });
}

const isEntrypoint =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isEntrypoint) {
  bootstrap().catch((err) => {
    const rawMessage = err instanceof Error ? err.stack ?? err.message : String(err);
    const safeMessage = redactSensitiveText(rawMessage, [
      env.MONGODB_URI,
      env.JWT_ACCESS_SECRET,
      env.JWT_REFRESH_SECRET,
      env.SMTP_PASS,
      env.EMAIL_WEBHOOK_API_KEY,
    ]);
    console.error('[TripLedger Server] Fatal startup error:', safeMessage);
    process.exit(1);
  });
}
