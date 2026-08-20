import { defineConfig } from "vitest/config";
import path from "node:path";

// Two environments in one run. Convex functions must execute inside an
// edge-runtime VM (that is what convex-test drives), while everything else is
// plain Node. Splitting by directory keeps each suite honest about what it is
// actually exercising.
export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, ".") },
  },
  test: {
    globals: true,
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["tests/unit/**/*.test.ts", "tests/money/**/*.test.ts", "tests/assessment/**/*.test.ts", "tests/agent/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "convex",
          environment: "edge-runtime",
          server: { deps: { inline: ["convex-test"] } },
          include: ["tests/convex/**/*.test.ts"],
        },
      },
    ],
  },
});
