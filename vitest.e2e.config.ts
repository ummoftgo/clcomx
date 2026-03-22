import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "smoke",
          environment: "node",
          include: ["e2e/smoke/**/*.test.ts"],
          fileParallelism: false,
          hookTimeout: 120_000,
          testTimeout: 120_000,
          reporters: "default",
        },
      },
      {
        test: {
          name: "settings",
          environment: "node",
          include: ["e2e/settings/**/*.test.ts"],
          fileParallelism: false,
          hookTimeout: 120_000,
          testTimeout: 120_000,
          reporters: "default",
        },
      },
      {
        test: {
          name: "windows-tabs",
          environment: "node",
          include: ["e2e/windows-tabs/**/*.test.ts"],
          fileParallelism: false,
          hookTimeout: 120_000,
          testTimeout: 120_000,
          reporters: "default",
        },
      },
      {
        test: {
          name: "workspace-restore",
          environment: "node",
          include: ["e2e/workspace-restore/**/*.test.ts"],
          fileParallelism: false,
          hookTimeout: 120_000,
          testTimeout: 120_000,
          reporters: "default",
        },
      },
      {
        test: {
          name: "image-paste",
          environment: "node",
          include: ["e2e/image-paste/**/*.test.ts"],
          fileParallelism: false,
          hookTimeout: 120_000,
          testTimeout: 120_000,
          reporters: "default",
        },
      },
      {
        test: {
          name: "terminal-input",
          environment: "node",
          include: ["e2e/terminal-input/**/*.test.ts"],
          fileParallelism: false,
          hookTimeout: 120_000,
          testTimeout: 120_000,
          reporters: "default",
        },
      },
      {
        test: {
          name: "terminal-links",
          environment: "node",
          include: ["e2e/terminal-links/**/*.test.ts"],
          fileParallelism: false,
          hookTimeout: 120_000,
          testTimeout: 120_000,
          reporters: "default",
        },
      },
    ],
  },
});
