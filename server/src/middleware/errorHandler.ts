import type { NextFunction, Request, Response } from 'express';
import mongoose from 'mongoose';
import { ZodError } from 'zod';
import { AppError } from '../utils/http.js';
import { redactSensitiveText } from '../utils/redact.js';

const INFRASTRUCTURE_UNAVAILABLE_ERROR_NAMES = new Set([
  'MongoNetworkError',
  'MongoNetworkTimeoutError',
  'MongoServerSelectionError',
  'MongoNotConnectedError',
  'MongoWaitQueueTimeoutError',
  'MongoTopologyClosedError',
]);

function isInvalidIdError(err: unknown): boolean {
  if (err instanceof mongoose.Error.CastError) return true;
  if (!(err instanceof Error)) return false;
  return err.name === 'CastError' || err.name === 'BSONError';
}

function isMalformedJsonError(err: unknown): boolean {
  return (
    err instanceof SyntaxError &&
    'status' in err &&
    (err as { status?: unknown }).status === 400 &&
    'body' in err
  );
}

function isInfrastructureUnavailableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (INFRASTRUCTURE_UNAVAILABLE_ERROR_NAMES.has(err.name)) {
    return true;
  }
  if (
    err.name === 'MongooseError' &&
    /buffering timed out|Client must be connected|not connected/i.test(err.message)
  ) {
    return true;
  }
  return false;
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
      },
    });
    return;
  }

  if (err instanceof ZodError) {
    const firstIssue = err.issues[0];
    res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: firstIssue
          ? `${firstIssue.path.join('.') || 'Input'}: ${firstIssue.message}`
          : 'Request validation failed',
        details: err.issues,
      },
    });
    return;
  }

  if (isMalformedJsonError(err)) {
    res.status(400).json({
      success: false,
      error: {
        code: 'INVALID_JSON',
        message: 'Malformed JSON request body.',
      },
    });
    return;
  }

  if (isInvalidIdError(err)) {
    res.status(400).json({
      success: false,
      error: {
        code: 'INVALID_ID',
        message: 'Invalid identifier format.',
      },
    });
    return;
  }

  if (err instanceof mongoose.Error.ValidationError || (err instanceof Error && err.name === 'ValidationError')) {
    res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed.',
      },
    });
    return;
  }

  if (isInfrastructureUnavailableError(err)) {
    const safeReason = err instanceof Error ? redactSensitiveText(err.message) : 'Infrastructure unavailable';
    console.error(`[TripLedger Error] ${req.method} ${req.path} -> 503:`, safeReason);
    res.status(503).json({
      success: false,
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'Service temporarily unavailable. Please try again later.',
      },
    });
    return;
  }

  if (err instanceof Error) {
    const safeReason = redactSensitiveText(err.message);
    console.error(
      `[TripLedger Error] ${req.method} ${req.path} -> 500 (${err.name}):`,
      safeReason
    );
  } else {
    console.error(`[TripLedger Error] ${req.method} ${req.path} -> 500: Non-Error thrown`);
  }

  res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected server error occurred.',
    },
  });
}
