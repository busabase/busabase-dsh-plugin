import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const require = createRequire(import.meta.url);
const testingLibraryRequire = createRequire(require.resolve("@testing-library/react"));
const testingLibraryRuntime = require.resolve("@testing-library/react");
const testSupport = (file: string) =>
  fileURLToPath(new URL(`./src/test-support/${file}`, import.meta.url));
const reactRuntime = testingLibraryRequire.resolve("react");
const reactJsxRuntime = testingLibraryRequire.resolve("react/jsx-runtime");
const reactJsxDevRuntime = testingLibraryRequire.resolve("react/jsx-dev-runtime");
const reactDomRuntime = testingLibraryRequire.resolve("react-dom");
const reactDomClientRuntime = testingLibraryRequire.resolve("react-dom/client");
const reactDomTestUtilsRuntime = testingLibraryRequire.resolve("react-dom/test-utils");
const sessionControllerScopeRuntime = resolve(
  dirname(require.resolve("@deepseek-ai/dsh-api-session-controller/package.json")),
  "lib/types/client/scope.js",
);

export default defineConfig({
  resolve: {
    // Root CI installs React 19 alongside this package's React 18 test runtime.
    // Keep JSX creation and Testing Library's renderer on the same React copy.
    alias: [
      {
        find: /^@testing-library\/react$/,
        replacement: testingLibraryRuntime,
      },
      {
        find: /^react$/,
        replacement: reactRuntime,
      },
      {
        find: /^react\/jsx-runtime$/,
        replacement: reactJsxRuntime,
      },
      {
        find: /^react\/jsx-dev-runtime$/,
        replacement: reactJsxDevRuntime,
      },
      {
        find: /^react-dom$/,
        replacement: reactDomRuntime,
      },
      {
        find: /^react-dom\/client$/,
        replacement: reactDomClientRuntime,
      },
      {
        find: /^react-dom\/test-utils$/,
        replacement: reactDomTestUtilsRuntime,
      },
      {
        find: "@deepseek-ai/dsh-client-ui-renderer/client",
        replacement: testSupport("dsh-renderer-source.ts"),
      },
      {
        find: "@deepseek-ai/dsh-client-ui-renderer/src/client/bind.ts",
        replacement: testSupport("dsh-renderer-source.ts"),
      },
      {
        find: "@deepseek-ai/dsh-client-ui-renderer/src/client/scoped-slots.tsx",
        replacement: testSupport("dsh-renderer-source.ts"),
      },
      {
        find: "@deepseek-ai/dsh-api-session-controller/src/client/scope.ts",
        replacement: sessionControllerScopeRuntime,
      },
      {
        find: "@deepseek-ai/dsh-api-session-controller/client",
        replacement: testSupport("dsh-session-controller-client.ts"),
      },
      {
        find: "@deepseek-ai/dsh-client-locale/client",
        replacement: testSupport("dsh-locale-client.ts"),
      },
      {
        find: "@deepseek-ai/dsh-client-ui-session/client",
        replacement: testSupport("dsh-session-client.ts"),
      },
      {
        find: "@deepseek-ai/dsh-client-ui-chat/client",
        replacement: testSupport("dsh-chat-client.ts"),
      },
      {
        find: "@deepseek-ai/dsh-client-ui-conversation/client",
        replacement: testSupport("dsh-conversation-client.ts"),
      },
      {
        find: "@deepseek-ai/dsh-client-ui-tool/client",
        replacement: testSupport("dsh-tool-client.ts"),
      },
    ],
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    restoreMocks: true,
    server: {
      deps: {
        inline: [
          "react",
          "react-dom",
          "@testing-library/react",
          "@testing-library/dom",
          "@deepseek-ai/dsh-client-test-runtime",
          "@deepseek-ai/dsh-client-ui-primitives",
          "@deepseek-ai/dsh-client-ui-dockkit",
        ],
      },
    },
  },
});
