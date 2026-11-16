import nodemailer, { type Transporter } from 'nodemailer';
import { type EmailDeliveryProvider } from '@tripledger/shared';
import {
  env,
  validateClientUrl,
  validateEmailConfig,
  type EnvConfig,
} from '../config/env.js';
import { AppError } from '../utils/http.js';

export interface VerificationEmailRequest {
  to: string;
  recipientName: string;
  rawToken: string;
  expiresInMinutes: number;
}

export interface EmailDeliveryResult {
  provider: EmailDeliveryProvider;
  messageId?: string;
}

export interface CapturedEmailMessage {
  to: string;
  from: string;
  subject: string;
  text: string;
  html: string;
  verificationUrl: string;
  sentAt: Date;
}

export interface EmailServiceDependencies {
  fetchImpl?: typeof fetch;
  smtpTransporterFactory?: (config: EnvConfig) => Pick<Transporter, 'sendMail'>;
}

const memoryEmailOutbox: CapturedEmailMessage[] = [];
const MAX_MEMORY_OUTBOX_ENTRIES = 200;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function buildEmailVerificationUrl(
  clientUrl: string,
  rawToken: string,
  nodeEnv: string
): string {
  const baseUrl = validateClientUrl(clientUrl, nodeEnv);
  const basePath = baseUrl.pathname.replace(/\/+$/, '');
  const target = new URL(baseUrl.origin);
  target.pathname = `${basePath}/verify-email`;
  target.searchParams.set('token', rawToken);
  return target.toString();
}

function redactSecrets(message: string, secrets: readonly string[]): string {
  let sanitized = message;
  for (const secret of secrets) {
    if (secret && secret.length > 0) {
      sanitized = sanitized.split(secret).join('[REDACTED]');
      sanitized = sanitized.split(encodeURIComponent(secret)).join('[REDACTED]');
    }
  }
  sanitized = sanitized.replace(/([?&]token=)[^&\s"']+/gi, '$1[REDACTED]');
  return sanitized;
}

function composeVerificationEmailPayload(
  params: VerificationEmailRequest,
  verificationUrl: string
): { subject: string; text: string; html: string } {
  const safeName = params.recipientName.trim() || 'there';
  const subject = 'Verify your TripLedger email address';
  const text = [
    `Hi ${safeName},`,
    '',
    'Please confirm your email address to enable verified TripLedger participant invitations.',
    `Verification link (expires in ${params.expiresInMinutes} minutes):`,
    verificationUrl,
    '',
    'If you did not create a TripLedger account, you can safely ignore this email.',
  ].join('\n');

  const escapedName = escapeHtml(safeName);
  const escapedUrl = escapeHtml(verificationUrl);
  const html = [
    `<p>Hi ${escapedName},</p>`,
    '<p>Please confirm your email address to enable verified TripLedger participant invitations.</p>',
    `<p><a href="${escapedUrl}">Verify Email Address</a></p>`,
    `<p>This verification link expires in ${params.expiresInMinutes} minutes.</p>`,
    '<p>If you did not create a TripLedger account, you can safely ignore this email.</p>',
  ].join('\n');

  return { subject, text, html };
}

export class EmailDeliveryService {
  private readonly config: EnvConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly smtpTransporterFactory: (
    config: EnvConfig
  ) => Pick<Transporter, 'sendMail'>;
  private readonly outbox: CapturedEmailMessage[];

  constructor(
    config: EnvConfig = env,
    deps: EmailServiceDependencies = {},
    outbox: CapturedEmailMessage[] = memoryEmailOutbox
  ) {
    this.config = config;
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    this.smtpTransporterFactory =
      deps.smtpTransporterFactory ??
      ((cfg) =>
        nodemailer.createTransport({
          host: cfg.SMTP_HOST,
          port: cfg.SMTP_PORT,
          secure: cfg.SMTP_SECURE,
          auth: cfg.SMTP_USER ? { user: cfg.SMTP_USER, pass: cfg.SMTP_PASS } : undefined,
          connectionTimeout: cfg.EMAIL_DELIVERY_TIMEOUT_MS,
          greetingTimeout: cfg.EMAIL_DELIVERY_TIMEOUT_MS,
          socketTimeout: cfg.EMAIL_DELIVERY_TIMEOUT_MS,
          disableFileAccess: true,
          disableUrlAccess: true,
        }));
    this.outbox = outbox;
  }

  public async sendVerificationEmail(
    request: VerificationEmailRequest
  ): Promise<EmailDeliveryResult> {
    if (
      this.config.EMAIL_PROVIDER === 'DISABLED' ||
      (this.config.NODE_ENV === 'production' && this.config.EMAIL_PROVIDER === 'MEMORY')
    ) {
      throw new AppError(
        'Verification email delivery is unavailable.',
        503,
        'EMAIL_DELIVERY_FAILED'
      );
    }

    try {
      validateEmailConfig(this.config);
    } catch {
      throw new AppError(
        'Verification email delivery configuration is invalid.',
        503,
        'EMAIL_DELIVERY_FAILED'
      );
    }

    let verificationUrl: string;
    try {
      verificationUrl = buildEmailVerificationUrl(
        this.config.CLIENT_URL,
        request.rawToken,
        this.config.NODE_ENV
      );
    } catch {
      throw new AppError(
        'Verification link configuration is invalid.',
        503,
        'EMAIL_DELIVERY_FAILED'
      );
    }

    const composed = composeVerificationEmailPayload(request, verificationUrl);
    const secretsToScrub = [
      request.rawToken,
      verificationUrl,
      this.config.SMTP_PASS,
      this.config.EMAIL_WEBHOOK_API_KEY,
    ];

    if (this.config.EMAIL_PROVIDER === 'MEMORY') {
      if (this.outbox.length >= MAX_MEMORY_OUTBOX_ENTRIES) {
        this.outbox.shift();
      }
      this.outbox.push({
        to: request.to,
        from: this.config.EMAIL_FROM,
        subject: composed.subject,
        text: composed.text,
        html: composed.html,
        verificationUrl,
        sentAt: new Date(),
      });
      return { provider: 'MEMORY' };
    }

    if (this.config.EMAIL_PROVIDER === 'SMTP') {
      try {
        const transporter = this.smtpTransporterFactory(this.config);
        const info = await transporter.sendMail({
          from: this.config.EMAIL_FROM,
          to: request.to,
          subject: composed.subject,
          text: composed.text,
          html: composed.html,
        });
        return {
          provider: 'SMTP',
          messageId: typeof info?.messageId === 'string' ? info.messageId : undefined,
        };
      } catch (err) {
        const safeReason = redactSecrets(
          err instanceof Error ? err.message : 'SMTP error',
          secretsToScrub
        );
        console.error('[TripLedger Email] SMTP verification delivery failed:', safeReason);
        throw new AppError(
          'Unable to deliver verification email at this time. Please try again later.',
          503,
          'EMAIL_DELIVERY_FAILED'
        );
      }
    }

    if (this.config.EMAIL_PROVIDER === 'WEBHOOK') {
      const controller = new AbortController();
      const timeoutHandle = setTimeout(
        () => controller.abort(),
        this.config.EMAIL_DELIVERY_TIMEOUT_MS
      );

      try {
        const response = await this.fetchImpl(this.config.EMAIL_WEBHOOK_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.config.EMAIL_WEBHOOK_API_KEY}`,
          },
          body: JSON.stringify({
            from: this.config.EMAIL_FROM,
            to: request.to,
            subject: composed.subject,
            text: composed.text,
            html: composed.html,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`Webhook responded with HTTP ${response.status}`);
        }

        const json = (await response.json().catch(() => null)) as { id?: unknown } | null;
        return {
          provider: 'WEBHOOK',
          messageId: typeof json?.id === 'string' ? json.id : undefined,
        };
      } catch (err) {
        const safeReason = redactSecrets(
          err instanceof Error ? err.message : 'Webhook delivery error',
          secretsToScrub
        );
        console.error('[TripLedger Email] Webhook verification delivery failed:', safeReason);
        throw new AppError(
          'Unable to deliver verification email at this time. Please try again later.',
          503,
          'EMAIL_DELIVERY_FAILED'
        );
      } finally {
        clearTimeout(timeoutHandle);
      }
    }

    throw new AppError(
      'Unsupported email delivery provider.',
      503,
      'EMAIL_DELIVERY_FAILED'
    );
  }
}

export const defaultEmailDeliveryService = new EmailDeliveryService(env);

export function getTestEmailOutbox(): readonly CapturedEmailMessage[] {
  if (env.NODE_ENV !== 'test') {
    throw new Error('Test email outbox is only accessible when NODE_ENV === "test".');
  }
  return memoryEmailOutbox;
}

export function clearTestEmailOutbox(): void {
  if (env.NODE_ENV !== 'test') {
    throw new Error('Test email outbox can only be cleared when NODE_ENV === "test".');
  }
  memoryEmailOutbox.length = 0;
}
