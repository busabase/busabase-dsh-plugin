/**
 * Replaces the value of every configured secret with a fixed placeholder in
 * arbitrary text (child process output, error messages, dumped config).
 * Never logs the secret itself, even at the call site.
 */
export function createSecretRedactor(
  secrets: readonly (string | undefined)[],
): (text: string) => string {
  const values = secrets.filter((value): value is string => Boolean(value && value.length >= 4));
  return (text: string): string => {
    let redacted = text;
    for (const value of values) redacted = redacted.split(value).join("[REDACTED]");
    return redacted;
  };
}
