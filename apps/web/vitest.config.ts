import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  // components can be rendered in tests (react-dom/server) with the same automatic JSX runtime Next uses
  esbuild: { jsx: "automatic" },
  resolve: { alias: { "@": fileURLToPath(new URL("./", import.meta.url)), "server-only": fileURLToPath(new URL("./tests/stubs/server-only.ts", import.meta.url)) } },
  // files run one after another: the notification store contract tests share one PostgreSQL database (counts must not race)
  test: { environment: "node", include: ["tests/**/*.test.ts"], fileParallelism: false },
});
