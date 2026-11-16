const SENSITIVE_URL_CRED_REGEX = /(https?:\/\/|mongodb(?:\+srv)?:\/\/)([^:@\s/]+):([^@\s/]+)@/gi;
const SENSITIVE_QUERY_TOKEN_REGEX = /([?&](?:token|secret|key|api_key|apiKey|password)=)[^&\s"'`]+/gi;
const SENSITIVE_BEARER_REGEX = /(Bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi;
const SENSITIVE_KV_REGEX = /\b(password|pass|secret|apiKey|api_key|token)\s*([=:])\s*([^\s,;'"`]+)/gi;

export function redactSensitiveText(
  message: string,
  extraSecrets: readonly string[] = []
): string {
  let sanitized = message;
  for (const secret of extraSecrets) {
    if (secret && secret.length > 0) {
      sanitized = sanitized.split(secret).join('[REDACTED]');
      sanitized = sanitized.split(encodeURIComponent(secret)).join('[REDACTED]');
    }
  }
  sanitized = sanitized.replace(SENSITIVE_URL_CRED_REGEX, '$1[REDACTED]:[REDACTED]@');
  sanitized = sanitized.replace(SENSITIVE_QUERY_TOKEN_REGEX, '$1[REDACTED]');
  sanitized = sanitized.replace(SENSITIVE_BEARER_REGEX, '$1[REDACTED]');
  sanitized = sanitized.replace(SENSITIVE_KV_REGEX, '$1$2[REDACTED]');
  return sanitized;
}
