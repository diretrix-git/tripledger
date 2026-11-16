import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { z } from 'zod';
import { createApp } from '../app.js';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { RateLimitBucketModel } from '../models/index.js';
import { AppError, asyncHandler } from '../utils/http.js';

const TEST_DB_URI = 'mongodb://127.0.0.1:27017/tripledger_test_error_handler';

describe('M-04: Error Handler & Store Failure Sanitization', () => {
  beforeAll(async () => {
    await connectDatabase(TEST_DB_URI);
  }, 30000);

  beforeEach(async () => {
    if (mongoose.connection.db) {
      await mongoose.connection.db.dropDatabase();
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    if (mongoose.connection.db) {
      await mongoose.connection.db.dropDatabase();
    }
    await disconnectDatabase();
  });

  it('preserves AppError and ZodError, maps CastError/BSONError to 400 INVALID_ID, and hides internal details on 500/503', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const harness = express();
    harness.use(express.json());

    harness.get(
      '/app-error',
      asyncHandler(async () => {
        throw new AppError('Custom business conflict.', 409, 'BUSINESS_CONFLICT', {
          field: 'email',
        });
      })
    );

    harness.post(
      '/zod-error',
      asyncHandler(async (req) => {
        z.object({ count: z.number().int().positive() }).parse(req.body);
      })
    );

    harness.get(
      '/cast-error',
      asyncHandler(async () => {
        throw new mongoose.Error.CastError('ObjectId', 'bad-id-123', '_id');
      })
    );

    harness.get(
      '/bson-error',
      asyncHandler(async () => {
        const bsonErr = new Error('input must be a 24 character hex string, 12 byte Uint8Array');
        bsonErr.name = 'BSONError';
        throw bsonErr;
      })
    );

    harness.get(
      '/mongo-network-error',
      asyncHandler(async () => {
        const netErr = new Error(
          'connect ECONNREFUSED mongodb://dbuser:supersecretpass@internal-mongo-node.corp:27017/tripledger'
        );
        netErr.name = 'MongoServerSelectionError';
        throw netErr;
      })
    );

    harness.get(
      '/unexpected-error',
      asyncHandler(async () => {
        throw new Error(
          'Unexpected query failure at mongodb://admin:topSecret99@prod-db.internal:27017/?token=rawVerifyTok123'
        );
      })
    );

    harness.use(errorHandler);

    const appErrRes = await request(harness).get('/app-error');
    expect(appErrRes.status).toBe(409);
    expect(appErrRes.body.error).toEqual({
      code: 'BUSINESS_CONFLICT',
      message: 'Custom business conflict.',
      details: { field: 'email' },
    });

    const zodRes = await request(harness).post('/zod-error').send({ count: -1 });
    expect(zodRes.status).toBe(400);
    expect(zodRes.body.error.code).toBe('VALIDATION_ERROR');

    const castRes = await request(harness).get('/cast-error');
    expect(castRes.status).toBe(400);
    expect(castRes.body.error).toEqual({
      code: 'INVALID_ID',
      message: 'Invalid identifier format.',
    });
    expect(JSON.stringify(castRes.body)).not.toContain('ObjectId');
    expect(JSON.stringify(castRes.body)).not.toContain('bad-id-123');

    const bsonRes = await request(harness).get('/bson-error');
    expect(bsonRes.status).toBe(400);
    expect(bsonRes.body.error.code).toBe('INVALID_ID');
    expect(JSON.stringify(bsonRes.body)).not.toContain('24 character');

    const jsonRes = await request(harness)
      .post('/zod-error')
      .set('Content-Type', 'application/json')
      .send('{"broken":');
    expect(jsonRes.status).toBe(400);
    expect(jsonRes.body.error.code).toBe('INVALID_JSON');

    const mongoRes = await request(harness).get('/mongo-network-error');
    expect(mongoRes.status).toBe(503);
    expect(mongoRes.body.error).toEqual({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Service temporarily unavailable. Please try again later.',
    });
    expect(JSON.stringify(mongoRes.body)).not.toContain('internal-mongo-node');
    expect(JSON.stringify(mongoRes.body)).not.toContain('supersecretpass');

    const unexpectedRes = await request(harness).get('/unexpected-error');
    expect(unexpectedRes.status).toBe(500);
    expect(unexpectedRes.body.error).toEqual({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected server error occurred.',
    });
    expect(JSON.stringify(unexpectedRes.body)).not.toContain('prod-db.internal');
    expect(JSON.stringify(unexpectedRes.body)).not.toContain('topSecret99');
    expect(JSON.stringify(unexpectedRes.body)).not.toContain('rawVerifyTok123');

    // Diagnostic logs keep error context while redacting credentials/tokens
    const logged = errSpy.mock.calls.flat().join(' ');
    expect(logged).not.toContain('supersecretpass');
    expect(logged).not.toContain('topSecret99');
    expect(logged).not.toContain('rawVerifyTok123');
    expect(logged).toContain('[REDACTED]');
  });

  it('sanitizes malformed ObjectId parameters on real routes and fails closed (503) on MongoRateLimitStore outage', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fullApp = createApp();

    const reg = await request(fullApp).post('/api/v1/auth/register').send({
      name: 'Route Tester',
      email: 'routetest@example.com',
      password: 'Password123',
    });
    expect(reg.status).toBe(201);
    const token = reg.body.data.accessToken as string;

    const malformedTripGet = await request(fullApp)
      .get('/api/v1/trips/not-a-valid-objectid')
      .set('Authorization', `Bearer ${token}`);
    expect(malformedTripGet.status).toBe(400);
    expect(malformedTripGet.body.error.code).toBe('INVALID_ID');
    expect(JSON.stringify(malformedTripGet.body)).not.toContain('Cast to ObjectId');

    // MongoRateLimitStore failure fails closed with 503 SERVICE_UNAVAILABLE instead of 400 or allowing through
    const rateLimitedApp = createApp({
      enableRateLimitInTest: true,
      rateLimitStoreOverride: 'mongo',
    });

    vi.spyOn(RateLimitBucketModel, 'findOneAndUpdate').mockRejectedValue(
      new Error('MongoServerSelectionError: connection lost to mongodb://user:secretPass@mongo.internal:27017')
    );

    const outageRes = await request(rateLimitedApp).post('/api/v1/auth/login').send({
      email: 'routetest@example.com',
      password: 'Password123',
    });
    expect(outageRes.status).toBe(503);
    expect(outageRes.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(JSON.stringify(outageRes.body)).not.toContain('mongo.internal');
    expect(JSON.stringify(outageRes.body)).not.toContain('secretPass');
  });
});
