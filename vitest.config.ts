import "dotenv/config";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    globalSetup: ["./vitest.global-setup.ts"],
    // Tests run against a real Postgres (docker compose) — never mocks: concurrency
    // and constraint behaviour is the thing under test.
    env: { DATABASE_URL: process.env.TEST_DATABASE_URL ?? "" },
    // One shared test DB → files must not run in parallel against it.
    fileParallelism: false,
  },
});
