export function isDuplicateKeyError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as {
    code?: unknown;
    cause?: { code?: unknown };
    errorResponse?: {
      code?: unknown;
      writeErrors?: Array<{ code?: unknown }>;
    };
    writeErrors?: Array<{ code?: unknown; err?: { code?: unknown } }>;
  };
  if (
    e.code === 11000 ||
    e.cause?.code === 11000 ||
    e.errorResponse?.code === 11000
  ) {
    return true;
  }
  if (Array.isArray(e.writeErrors)) {
    if (e.writeErrors.some((w) => w?.code === 11000 || w?.err?.code === 11000)) {
      return true;
    }
  }
  if (Array.isArray(e.errorResponse?.writeErrors)) {
    if (e.errorResponse.writeErrors.some((w) => w?.code === 11000)) {
      return true;
    }
  }
  return false;
}
