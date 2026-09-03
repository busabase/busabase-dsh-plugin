import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import * as cordis from "@deepseek-ai/cordis";
import * as primitives from "@deepseek-ai/dsh-client-ui-primitives";
import * as slots from "@deepseek-ai/dsh-client-ui-slots";
import * as react from "react";
import * as jsxRuntime from "react/jsx-runtime";
import * as reactDom from "react-dom";
import * as reactDomClient from "react-dom/client";

interface ClientBundleDefinition {
  id: string;
  factory: (requireModule: (id: string) => unknown) => Record<string, unknown>;
}

interface ModuleLoaderWindow extends Window {
  __ModuleLoader__?: {
    load(definition: ClientBundleDefinition): void;
  };
}

const externalModules = new Map<string, unknown>([
  ["@deepseek-ai/cordis", cordis],
  ["@deepseek-ai/dsh-client-ui-primitives", primitives],
  ["@deepseek-ai/dsh-client-ui-slots", slots],
  ["react", react],
  ["react-dom", reactDom],
  ["react-dom/client", reactDomClient],
  ["react/jsx-runtime", jsxRuntime],
]);

const definitions = new Map<string, ClientBundleDefinition>();
const modules = new Map<string, Record<string, unknown>>();
const rootRequire = createRequire(import.meta.url);

const normalizeClientId = (id: string): string => id.replace(/\/client$/, "");

const clientBundlePath = (id: string, parentPath?: string): string => {
  const requireFromParent = parentPath ? createRequire(parentPath) : rootRequire;
  const packageJson = requireFromParent.resolve(`${normalizeClientId(id)}/package.json`);
  return join(dirname(packageJson), "lib/client.js");
};

const exposeRendererTestExports = (source: string): string => {
  const marker = "exports.apply = apply;";
  if (!source.includes(marker)) {
    throw new Error("Harness renderer bundle no longer exposes the expected apply marker");
  }
  return source.replace(
    marker,
    [
      "exports.bindSnapshotSelector = bindSnapshotSelector;",
      "exports.createSlotRenderer = createSlotRenderer;",
      marker,
    ].join("\n\t\t"),
  );
};

const registerBundle = (id: string, parentPath?: string): string => {
  const normalizedId = normalizeClientId(id);
  if (definitions.has(normalizedId)) return clientBundlePath(normalizedId, parentPath);

  const bundlePath = clientBundlePath(normalizedId, parentPath);
  let source = readFileSync(bundlePath, "utf8");
  if (normalizedId === "@deepseek-ai/dsh-client-ui-renderer") {
    source = exposeRendererTestExports(source);
  }

  const browserWindow = window as ModuleLoaderWindow;
  const previousLoader = browserWindow.__ModuleLoader__;
  browserWindow.__ModuleLoader__ = {
    load(definition) {
      definitions.set(normalizeClientId(definition.id), definition);
    },
  };
  try {
    Function(source)();
  } finally {
    browserWindow.__ModuleLoader__ = previousLoader;
  }

  if (!definitions.has(normalizedId)) {
    throw new Error(`Harness client bundle did not register ${normalizedId}`);
  }
  return bundlePath;
};

export const loadOfficialClientModule = (
  id: string,
  parentPath?: string,
): Record<string, unknown> => {
  const external = externalModules.get(id);
  if (external) return external as Record<string, unknown>;

  const normalizedId = normalizeClientId(id);
  const cached = modules.get(normalizedId);
  if (cached) return cached;

  const bundlePath = registerBundle(normalizedId, parentPath);
  const definition = definitions.get(normalizedId);
  if (!definition) throw new Error(`Harness client definition missing for ${normalizedId}`);

  const exports = definition.factory((dependencyId) =>
    loadOfficialClientModule(dependencyId, bundlePath),
  );
  modules.set(normalizedId, exports);
  return exports;
};
