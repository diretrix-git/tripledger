import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';

describe('TripLedger API Health & Foundation', () => {
  it('returns healthy status and NPR currency configuration on GET /api/v1/health', async () => {
    const app = createApp();
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.service).toBe('TripLedger API');
    expect(res.body.data.currency).toBe('NPR');
  });
});
