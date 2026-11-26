import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    globals: false,
    // Never touch the real ~/.ghostrow or ghostrow.com from tests.
    env: { GHOSTROW_HOME: join(tmpdir(), "ghostrow-test-home"), GHOSTROW_API_URL: "http://127.0.0.1:9" },
  },
});
