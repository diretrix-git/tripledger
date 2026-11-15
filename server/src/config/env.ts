import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '../.env') });
dotenv.config();

export const env = {
  NODE_ENV: process.env.NODE_ENV ?? 'development',
  PORT: Number.parseInt(process.env.PORT ?? '5000', 10),
  CLIENT_URL: process.env.CLIENT_URL ?? 'http://localhost:5173',
  MONGODB_URI: process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/tripledger',
  USE_IN_MEMORY_DB: process.env.USE_IN_MEMORY_DB === 'true',
  JWT_ACCESS_SECRET:
    process.env.JWT_ACCESS_SECRET ?? 'tripledger-dev-access-secret-do-not-use-in-prod-998877',
  JWT_REFRESH_SECRET:
    process.env.JWT_REFRESH_SECRET ?? 'tripledger-dev-refresh-secret-do-not-use-in-prod-112233',
  JWT_ACCESS_EXPIRES_IN: process.env.JWT_ACCESS_EXPIRES_IN ?? '15m',
  JWT_REFRESH_EXPIRES_IN: process.env.JWT_REFRESH_EXPIRES_IN ?? '7d',
  BCRYPT_SALT_ROUNDS: Number.parseInt(process.env.BCRYPT_SALT_ROUNDS ?? '10', 10),
  RATE_LIMIT_WINDOW_MS: Number.parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? '900000', 10),
  RATE_LIMIT_MAX_REQUESTS: Number.parseInt(process.env.RATE_LIMIT_MAX_REQUESTS ?? '500', 10),
};
