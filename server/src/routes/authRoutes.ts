import { Router } from 'express';
import { createAuthHandlers } from '../controllers/authController.js';
import { requireAuth } from '../middleware/auth.js';
import type { EmailDeliveryService } from '../services/emailService.js';
import {
  createAuthRateLimiters,
  resolveEffectiveRateLimitConfig,
  type AuthRateLimiters,
} from '../services/rateLimitStore.js';

export interface CreateAuthRouterOptions {
  emailDeliveryService?: EmailDeliveryService;
  rateLimiters?: AuthRateLimiters;
}

export function createAuthRouter(options: CreateAuthRouterOptions = {}): Router {
  const handlers = createAuthHandlers(options.emailDeliveryService);
  const effective = resolveEffectiveRateLimitConfig();
  const limiters =
    options.rateLimiters ??
    createAuthRateLimiters({
      enabled: effective.enabled,
      storeType: effective.storeType,
    });

  const router = Router();
  router.post('/register', limiters.register, handlers.register);
  router.post('/login', limiters.login, handlers.login);
  router.post('/verify-email', limiters.verifyEmail, handlers.verifyEmail);
  router.post(
    '/resend-verification',
    requireAuth,
    limiters.resendVerification,
    handlers.resendVerification
  );
  router.post('/refresh', handlers.refresh);
  router.post('/logout', requireAuth, handlers.logout);
  router.get('/me', requireAuth, handlers.getMe);
  router.patch('/me', requireAuth, handlers.updateMe);

  return router;
}

export const authRouter = createAuthRouter();
