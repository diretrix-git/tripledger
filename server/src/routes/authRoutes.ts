import { Router } from 'express';
import {
  getMe,
  login,
  logout,
  refresh,
  register,
  updateMe,
} from '../controllers/authController.js';
import { requireAuth } from '../middleware/auth.js';

export const authRouter = Router();

authRouter.post('/register', register);
authRouter.post('/login', login);
authRouter.post('/refresh', refresh);
authRouter.post('/logout', requireAuth, logout);
authRouter.get('/me', requireAuth, getMe);
authRouter.patch('/me', requireAuth, updateMe);
