import { afterEach, describe, expect, it, vi } from 'vitest';
import { EMAIL_VERIFICATION_TTL_MINUTES } from '@tripledger/shared';
import {
  buildEnvConfig,
  parseTrustProxySetting,
  validateClientUrl,
  validateEmailConfig,
  validateProductionStartupConfig,
  validateRateLimitTopologyConfig,
} from '../config/env.js';
import { bootstrap } from '../index.js';
import {
  buildEmailVerificationUrl,
  clearTestEmailOutbox,
  EmailDeliveryService,
  getTestEmailOutbox,
  type CapturedEmailMessage,
} from '../services/emailService.js';
import { generateEmailVerificationToken, hashToken } from '../utils/tokens.js';

function validProductionEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    NODE_ENV: 'production',
    PORT: '5000',
    CLIENT_URL: 'https://app.tripledger.example',
    MONGODB_URI: 'mongodb+srv://cluster.example/tripledger',
    JWT_ACCESS_SECRET: 'prod-access-secret-with-more-than-32-chars-aaa111',
    JWT_REFRESH_SECRET: 'prod-refresh-secret-with-more-than-32-chars-bbb222',
    EMAIL_PROVIDER: 'WEBHOOK',
    EMAIL_FROM: 'TripLedger <no-reply@tripledger.example>',
    EMAIL_WEBHOOK_URL: 'https://mailer.tripledger.example/v1/send',
    EMAIL_WEBHOOK_API_KEY: 'wh-secret-key-999',
    ...overrides,
  };
}

describe('Phase 2 Commit 1: Email configuration, delivery providers, and startup validation', () => {
  afterEach(() => {
    clearTestEmailOutbox();
    vi.restoreAllMocks();
  });

  it('enforces fail-closed production startup config for email delivery, HTTPS CLIENT_URL, proxy, JWT secrets, and rate-limit store', () => {
    expect(() => validateProductionStartupConfig(buildEnvConfig(validProductionEnv()))).not.toThrow();

    // Production defaults to DISABLED when EMAIL_PROVIDER is omitted and MUST reject DISABLED or MEMORY
    expect(() =>
      validateEmailConfig(buildEnvConfig(validProductionEnv({ EMAIL_PROVIDER: undefined })))
    ).toThrow(/prohibited in production/i);
    expect(() =>
      validateEmailConfig(buildEnvConfig(validProductionEnv({ EMAIL_PROVIDER: 'DISABLED' })))
    ).toThrow(/prohibited in production/i);
    expect(() =>
      validateEmailConfig(buildEnvConfig(validProductionEnv({ EMAIL_PROVIDER: 'MEMORY' })))
    ).toThrow(/prohibited in production/i);

    // Production requires HTTPS non-localhost CLIENT_URL
    expect(() =>
      validateClientUrl('http://app.tripledger.example', 'production')
    ).toThrow(/https:\/\//i);
    expect(() => validateClientUrl('https://localhost:5173', 'production')).toThrow(/localhost/i);
    expect(() => validateClientUrl('https://127.0.0.1:5173', 'production')).toThrow(/loopback/i);
    expect(() => validateClientUrl('https://user:pass@app.tripledger.example', 'production')).toThrow(
      /credentials/i
    );

    // SMTP config validation in production
    expect(() =>
      validateEmailConfig(
        buildEnvConfig(
          validProductionEnv({
            EMAIL_PROVIDER: 'SMTP',
            SMTP_HOST: 'smtp.tripledger.example',
            SMTP_PORT: '587',
            SMTP_USER: 'mailer',
            SMTP_PASS: 'app-password',
          })
        )
      )
    ).not.toThrow();
    expect(() =>
      validateEmailConfig(
        buildEnvConfig(
          validProductionEnv({
            EMAIL_PROVIDER: 'SMTP',
            SMTP_HOST: '',
            SMTP_USER: 'mailer',
            SMTP_PASS: 'app-password',
          })
        )
      )
    ).toThrow(/SMTP_HOST/i);
    expect(() =>
      validateEmailConfig(
        buildEnvConfig(
          validProductionEnv({
            EMAIL_PROVIDER: 'SMTP',
            SMTP_HOST: 'smtp.tripledger.example',
            SMTP_USER: '',
            SMTP_PASS: '',
          })
        )
      )
    ).toThrow(/SMTP_USER/i);

    // WEBHOOK requires https:// and API key in production
    expect(() =>
      validateEmailConfig(
        buildEnvConfig(
          validProductionEnv({
            EMAIL_PROVIDER: 'WEBHOOK',
            EMAIL_WEBHOOK_URL: 'http://mailer.tripledger.example/send',
          })
        )
      )
    ).toThrow(/https:\/\//i);
    expect(() =>
      validateEmailConfig(
        buildEnvConfig(
          validProductionEnv({
            EMAIL_PROVIDER: 'WEBHOOK',
            EMAIL_WEBHOOK_API_KEY: '',
          })
        )
      )
    ).toThrow(/EMAIL_WEBHOOK_API_KEY/i);

    // Production defaults RATE_LIMIT_STORE=mongo and rejects per-process memory in multi-instance topology
    const prodConfig = buildEnvConfig(validProductionEnv());
    expect(prodConfig.RATE_LIMIT_STORE).toBe('mongo');
    expect(() =>
      validateRateLimitTopologyConfig(
        buildEnvConfig(validProductionEnv({ RATE_LIMIT_STORE: 'memory' }))
      )
    ).toThrow(/multi-instance/i);
    expect(() =>
      validateRateLimitTopologyConfig(
        buildEnvConfig(
          validProductionEnv({
            RATE_LIMIT_STORE: 'memory',
            DEPLOYMENT_TOPOLOGY: 'single-instance',
          })
        )
      )
    ).not.toThrow();

    // Production prohibits wildcard TRUST_PROXY="true"
    expect(() => parseTrustProxySetting('true', 'production')).toThrow(/prohibited/i);
    expect(parseTrustProxySetting('1', 'production')).toBe(1);
    expect(parseTrustProxySetting('loopback', 'production')).toBe('loopback');

    // Placeholder JWT secrets are rejected in production
    expect(() =>
      validateProductionStartupConfig(
        buildEnvConfig(validProductionEnv({ JWT_ACCESS_SECRET: undefined }))
      )
    ).toThrow(/JWT_ACCESS_SECRET/i);
  });

  it('fails fast during bootstrap before connecting DB or calling app.listen when production email config is invalid', async () => {
    const connectDb = vi.fn(async () => {});
    const listen = vi.fn();
    const createAppFn = vi.fn(() => ({ listen }) as unknown as ReturnType<typeof import('../app.js').createApp>);

    await expect(
      bootstrap(buildEnvConfig(validProductionEnv({ EMAIL_PROVIDER: 'DISABLED' })), {
        connectDb,
        createAppFn,
      })
    ).rejects.toThrow(/EMAIL_PROVIDER/i);

    expect(connectDb).not.toHaveBeenCalled();
    expect(createAppFn).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
  });

  it('generates high-entropy SHA-256 verification tokens and builds safe verification links', () => {
    const t1 = generateEmailVerificationToken();
    const t2 = generateEmailVerificationToken();

    expect(t1.rawToken.length).toBeGreaterThanOrEqual(32);
    expect(t1.rawToken).not.toBe(t2.rawToken);
    expect(t1.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(t1.tokenHash).toBe(hashToken(t1.rawToken));
    const expectedWindowMs = EMAIL_VERIFICATION_TTL_MINUTES * 60 * 1000;
    const diffMs = t1.expiresAt.getTime() - Date.now();
    expect(diffMs).toBeGreaterThan(expectedWindowMs - 5000);
    expect(diffMs).toBeLessThanOrEqual(expectedWindowMs + 1000);

    const url = buildEmailVerificationUrl(
      'https://app.tripledger.example/app/',
      'tok+abc/def=12345678',
      'production'
    );
    expect(url).toBe(
      'https://app.tripledger.example/app/verify-email?token=tok%2Babc%2Fdef%3D12345678'
    );
  });

  it('delivers via MEMORY without logging raw tokens and rejects MEMORY or DISABLED at send time cleanly', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const outbox: CapturedEmailMessage[] = [];
    const memorySvc = new EmailDeliveryService(
      buildEnvConfig({ NODE_ENV: 'test', EMAIL_PROVIDER: 'MEMORY' }),
      {},
      outbox
    );

    const rawSecretToken = 'secret-raw-verify-token-abcdef123456';
    const result = await memorySvc.sendVerificationEmail({
      to: 'user@example.com',
      recipientName: '<script>alert(1)</script> Alice',
      rawToken: rawSecretToken,
      expiresInMinutes: 30,
    });

    expect(result.provider).toBe('MEMORY');
    expect(outbox).toHaveLength(1);
    expect(outbox[0].to).toBe('user@example.com');
    expect(outbox[0].html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(outbox[0].verificationUrl).toContain(rawSecretToken);
    expect(logSpy).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();

    // Also verify global test outbox helper works only in NODE_ENV === 'test'
    await new EmailDeliveryService(
      buildEnvConfig({ NODE_ENV: 'test', EMAIL_PROVIDER: 'MEMORY' })
    ).sendVerificationEmail({
      to: 'global@example.com',
      recipientName: 'Global User',
      rawToken: rawSecretToken,
      expiresInMinutes: 30,
    });
    expect(getTestEmailOutbox()).toHaveLength(1);

    // DISABLED fails safely with 503 EMAIL_DELIVERY_FAILED
    const disabledSvc = new EmailDeliveryService(
      buildEnvConfig({ NODE_ENV: 'development', EMAIL_PROVIDER: 'DISABLED' })
    );
    await expect(
      disabledSvc.sendVerificationEmail({
        to: 'user@example.com',
        recipientName: 'Alice',
        rawToken: rawSecretToken,
        expiresInMinutes: 30,
      })
    ).rejects.toMatchObject({ statusCode: 503, code: 'EMAIL_DELIVERY_FAILED' });

    // Production + MEMORY fails safely even if invoked directly
    const prodMemSvc = new EmailDeliveryService(
      buildEnvConfig(validProductionEnv({ EMAIL_PROVIDER: 'MEMORY' }))
    );
    await expect(
      prodMemSvc.sendVerificationEmail({
        to: 'user@example.com',
        recipientName: 'Alice',
        rawToken: rawSecretToken,
        expiresInMinutes: 30,
      })
    ).rejects.toMatchObject({ statusCode: 503, code: 'EMAIL_DELIVERY_FAILED' });
  });

  it('delivers via WEBHOOK and SMTP (nodemailer), scrubbing raw tokens & secrets from logs and thrown errors on failure', async () => {
    const rawSecretToken = 'top-secret-token-never-log-me-987654';
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // 1. WEBHOOK success
    const fetchOk = vi.fn(async () => new Response(JSON.stringify({ id: 'wh-msg-1' }), { status: 202 }));
    const webhookSvc = new EmailDeliveryService(
      buildEnvConfig(validProductionEnv({ EMAIL_PROVIDER: 'WEBHOOK' })),
      { fetchImpl: fetchOk as unknown as typeof fetch }
    );
    const whRes = await webhookSvc.sendVerificationEmail({
      to: 'alice@example.com',
      recipientName: 'Alice',
      rawToken: rawSecretToken,
      expiresInMinutes: 30,
    });
    expect(whRes).toEqual({ provider: 'WEBHOOK', messageId: 'wh-msg-1' });
    expect(fetchOk).toHaveBeenCalledTimes(1);

    // 2. WEBHOOK failure scrubs token and webhook API key
    const fetchFail = vi.fn(async () => {
      throw new Error(
        `Request failed for ${rawSecretToken} with key wh-secret-key-999 at https://app.tripledger.example/verify-email?token=${rawSecretToken}`
      );
    });
    const webhookFailSvc = new EmailDeliveryService(
      buildEnvConfig(validProductionEnv({ EMAIL_PROVIDER: 'WEBHOOK' })),
      { fetchImpl: fetchFail as unknown as typeof fetch }
    );
    await expect(
      webhookFailSvc.sendVerificationEmail({
        to: 'alice@example.com',
        recipientName: 'Alice',
        rawToken: rawSecretToken,
        expiresInMinutes: 30,
      })
    ).rejects.toMatchObject({ statusCode: 503, code: 'EMAIL_DELIVERY_FAILED' });

    const loggedText = consoleErrorSpy.mock.calls.flat().join(' ');
    expect(loggedText).not.toContain(rawSecretToken);
    expect(loggedText).not.toContain('wh-secret-key-999');

    // 3. SMTP success & failure via nodemailer factory
    const sendMailOk = vi.fn(async () => ({ messageId: 'smtp-msg-1' }));
    const smtpCfg = buildEnvConfig(
      validProductionEnv({
        EMAIL_PROVIDER: 'SMTP',
        SMTP_HOST: 'smtp.tripledger.example',
        SMTP_PORT: '587',
        SMTP_USER: 'smtp-user',
        SMTP_PASS: 'smtp-secret-pass-777',
      })
    );
    const smtpSvc = new EmailDeliveryService(smtpCfg, {
      smtpTransporterFactory: () => ({ sendMail: sendMailOk }) as never,
    });
    const smtpRes = await smtpSvc.sendVerificationEmail({
      to: 'bob@example.com',
      recipientName: 'Bob',
      rawToken: rawSecretToken,
      expiresInMinutes: 30,
    });
    expect(smtpRes).toEqual({ provider: 'SMTP', messageId: 'smtp-msg-1' });
    expect(sendMailOk).toHaveBeenCalledTimes(1);

    consoleErrorSpy.mockClear();
    const smtpFailSvc = new EmailDeliveryService(smtpCfg, {
      smtpTransporterFactory: () =>
        ({
          sendMail: vi.fn(async () => {
            throw new Error(`AUTH failed pass=smtp-secret-pass-777 token=${rawSecretToken}`);
          }),
        }) as never,
    });
    await expect(
      smtpFailSvc.sendVerificationEmail({
        to: 'bob@example.com',
        recipientName: 'Bob',
        rawToken: rawSecretToken,
        expiresInMinutes: 30,
      })
    ).rejects.toMatchObject({ statusCode: 503, code: 'EMAIL_DELIVERY_FAILED' });

    const smtpLogged = consoleErrorSpy.mock.calls.flat().join(' ');
    expect(smtpLogged).not.toContain(rawSecretToken);
    expect(smtpLogged).not.toContain('smtp-secret-pass-777');
  });
});
