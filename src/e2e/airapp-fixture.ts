/**
 * Minimal AirApp file set the E2E model task publishes through
 * `busabase-sdk/airapp`'s `publishAirApp`. Deliberately dependency-free
 * (plain `node:http`, no Hono/Vite/Next/native modules) so the driver's
 * canonical-shape assertion — "npm run dev, plain Node server, no
 * Vite/Next/native deps" — is satisfied by construction, and so installing
 * or running it never depends on network access to npm.
 */

export interface AirAppFile {
  path: string;
  content: string;
}

export function buildMinimalAirAppFiles(appSlug: string): AirAppFile[] {
  const packageJson = {
    name: appSlug,
    private: true,
    version: "0.1.0",
    type: "module",
    scripts: {
      dev: "node server.js",
      start: "node server.js",
    },
  };
  const serverJs = `import { createServer } from "node:http";

const port = Number.parseInt(process.env.PORT || "3000", 10);
const server = createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: true, app: ${JSON.stringify(appSlug)} }));
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(\`<!doctype html><html><body><main><h1>\${${JSON.stringify(appSlug)}}</h1><p>AirApp is running.</p></main></body></html>\`);
});
server.listen(port, () => {
  console.log(\`AirApp listening on port \${port}\`);
});
`;
  return [
    { path: "package.json", content: `${JSON.stringify(packageJson, null, 2)}\n` },
    { path: "server.js", content: serverJs },
  ];
}

const DISALLOWED_DEPENDENCY_PATTERN = /^(vite|next|react-native|@vitejs|electron|node-gyp)/i;

export interface CanonicalAirAppShapeCheck {
  ok: boolean;
  reasons: string[];
}

/**
 * Verifies the canonical AirApp's `package.json` declares a plain-Node
 * `npm run dev` entry point and no Vite/Next/native runtime dependency —
 * the deterministic, server-side-state assertion from the task spec that
 * must hold regardless of what the model's final prose claims.
 */
export function checkCanonicalAirAppShape(packageJsonText: string): CanonicalAirAppShapeCheck {
  const reasons: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJsonText);
  } catch {
    return { ok: false, reasons: ["package.json is not valid JSON"] };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, reasons: ["package.json did not parse to an object"] };
  }
  const record = parsed as Record<string, unknown>;
  const scripts = (record.scripts as Record<string, unknown> | undefined) ?? {};
  const devScript = scripts.dev;
  if (typeof devScript !== "string" || !/^node\s+\S+\.(m|c)?js$/.test(devScript.trim())) {
    reasons.push(`scripts.dev must run a plain Node server, got: ${JSON.stringify(devScript)}`);
  }

  const dependencyNames = [
    ...Object.keys((record.dependencies as Record<string, unknown> | undefined) ?? {}),
    ...Object.keys((record.devDependencies as Record<string, unknown> | undefined) ?? {}),
  ];
  const disallowed = dependencyNames.filter((name) => DISALLOWED_DEPENDENCY_PATTERN.test(name));
  if (disallowed.length > 0)
    reasons.push(`disallowed dependencies present: ${disallowed.join(", ")}`);

  return { ok: reasons.length === 0, reasons };
}
