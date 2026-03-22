#!/usr/bin/env node

import { spawn } from "node:child_process";

const project = process.argv[2];
const extraArgs = process.argv.slice(3);

if (!project) {
  console.error("Usage: node scripts/run-e2e-project.mjs <project> [args...]");
  process.exit(1);
}

const isWindows = process.platform === "win32";

const command = isWindows ? "powershell.exe" : "npx";
const args = isWindows
  ? [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      ".\\scripts\\e2e-smoke-windows.ps1",
      "-Project",
      project,
      ...extraArgs,
    ]
  : [
      "vitest",
      "run",
      "--config",
      "./vitest.e2e.config.ts",
      "--project",
      project,
      ...extraArgs,
    ];

const child = spawn(command, args, {
  stdio: "inherit",
  shell: false,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
