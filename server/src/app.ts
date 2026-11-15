import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { env } from './config/env.js';
import { errorHandler } from './middleware/errorHandler.js';
import { authRouter } from './routes/authRoutes.js';
import { publicSharedRouter } from './routes/settlementAndReportRoutes.js';
import { dashboardRouter, tripRouter } from './routes/tripRoutes.js';
import { sendSuccess } from './utils/http.js';

export function createApp(): express.Application {
  const app = express();

  app.use(helmet());
  app.use(
    cors({
      origin: env.CLIENT_URL,
      credentials: true,
    })
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  if (env.NODE_ENV !== 'test') {
    app.use(
      '/api',
      rateLimit({
        windowMs: env.RATE_LIMIT_WINDOW_MS,
        max: env.RATE_LIMIT_MAX_REQUESTS,
        standardHeaders: true,
        legacyHeaders: false,
      })
    );
  }

  app.get('/api/v1/health', (_req, res) => {
    sendSuccess(res, {
      service: 'TripLedger API',
      status: 'healthy',
      currency: 'NPR',
    });
  });

  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/dashboard', dashboardRouter);
  app.use('/api/v1/trips', tripRouter);
  app.use('/api/v1/shared', publicSharedRouter);

  app.use(errorHandler);

  return app;
}
