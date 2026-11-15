import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../utils/http.js';

export function errorHandler(
  err: unknown,
  _req: Request,
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

  if (err instanceof Error) {
    res.status(400).json({
      success: false,
      error: {
        code: 'REQUEST_ERROR',
        message: err.message,
      },
    });
    return;
  }

  res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected server error occurred.',
    },
  });
}
