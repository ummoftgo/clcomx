import fs from "node:fs";
import path from "node:path";

const projectDir = process.argv[2];

if (!projectDir) {
  console.error("Missing project directory argument");
  process.exit(1);
}

const workspacePath = path.join(projectDir, "workspace.json");

if (!fs.existsSync(workspacePath)) {
  process.exit(0);
}

const raw = fs.readFileSync(workspacePath, "utf8");
const parsed = JSON.parse(raw);

const defaultMain = {
  label: "main",
  name: "main",
  role: "main",
  tabs: [],
  activeSessionId: null,
  x: 0,
  y: 0,
  width: 1024,
  height: 720,
  maximized: false,
};

const mainWindow = Array.isArray(parsed?.windows)
  ? parsed.windows.find((window) => window?.label === "main") ?? defaultMain
  : defaultMain;

const nextWorkspace = {
  windows: [mainWindow],
};

fs.writeFileSync(workspacePath, `${JSON.stringify(nextWorkspace, null, 2)}\n`);
