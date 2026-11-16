import path from 'path';
import { pathToFileURL } from 'url';
import { createApp } from './app.js';
import { connectDatabase } from './config/database.js';
import { env, validateProductionStartupConfig, type EnvConfig } from './config/env.js';
import { ensureRateLimitIndexes } from './services/rateLimitStore.js';

export async function bootstrap(
  config: EnvConfig = env,
  deps: {
    connectDb?: () => Promise<void>;
    ensureIndexesFn?: () => Promise<void>;
    createAppFn?: typeof createApp;
  } = {}
): Promise<void> {
  // Validate production email delivery, HTTPS CLIENT_URL, proxy/rate-limit topology, and JWT secrets BEFORE connecting or listening.
  validateProductionStartupConfig(config);
  await (deps.connectDb ? deps.connectDb() : connectDatabase());
  if (config.RATE_LIMIT_STORE === 'mongo') {
    await (deps.ensureIndexesFn ? deps.ensureIndexesFn() : ensureRateLimitIndexes());
  }
  const app = (deps.createAppFn ?? createApp)();
  app.listen(config.PORT, () => {
    console.log(`[TripLedger Server] Running on http://localhost:${config.PORT}`);
  });
}

const isEntrypoint =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isEntrypoint) {
  bootstrap().catch((err) => {
    console.error('[TripLedger Server] Fatal startup error:', err);
    process.exit(1);
  });
}
