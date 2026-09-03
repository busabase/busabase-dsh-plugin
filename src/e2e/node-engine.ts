export interface NodeEngineCheck {
  ok: boolean;
  required: string;
  actual: string;
  reason?: string;
}

/**
 * Compares the running Node version against a `>=x.y.z` engines requirement.
 * Only the `>=` operator is supported because that is the only shape the
 * plugin's dependencies (busabase-sdk) declare; anything else is a config error.
 */
export function checkNodeEngine(
  requirement: string,
  actualVersion: string = process.version,
): NodeEngineCheck {
  const match = /^>=\s*(\d+)\.(\d+)\.(\d+)$/.exec(requirement.trim());
  if (!match)
    return {
      ok: false,
      required: requirement,
      actual: actualVersion,
      reason: `unsupported engines requirement syntax: ${requirement}`,
    };
  const required = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  const actual = parseVersion(actualVersion);
  if (!actual)
    return {
      ok: false,
      required: requirement,
      actual: actualVersion,
      reason: `unparseable Node version: ${actualVersion}`,
    };
  const ok = compareVersions(actual, required) >= 0;
  return {
    ok,
    required: requirement,
    actual: actualVersion,
    reason: ok
      ? undefined
      : `Node ${actualVersion} does not satisfy ${requirement} (required by busabase-sdk)`,
  };
}

function parseVersion(value: string): [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}
