import { createApp } from './app.js';
import { connectDatabase } from './config/database.js';
import { env } from './config/env.js';

async function bootstrap() {
  await connectDatabase();
  const app = createApp();
  app.listen(env.PORT, () => {
    console.log(`[TripLedger Server] Running on http://localhost:${env.PORT}`);
  });
}

bootstrap().catch((err) => {
  console.error('[TripLedger Server] Fatal startup error:', err);
  process.exit(1);
});
