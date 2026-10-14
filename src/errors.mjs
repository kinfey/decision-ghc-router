export function safeError(error, env) {
  let text = error instanceof Error ? error.message : String(error);
  for (const [key, value] of Object.entries(env)) {
    if (value && /KEY|TOKEN|SECRET|PASSWORD/i.test(key)) text = text.replaceAll(value, "[REDACTED]");
  }
  return text.replace(/\bapikey_[A-Za-z0-9_]+\b/g, "[REDACTED]");
}
