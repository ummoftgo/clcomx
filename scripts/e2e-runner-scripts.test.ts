import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();

describe("Windows E2E runner scripts", () => {
  it("preserves installed Windows E2E tools across mirror sync", () => {
    const script = fs.readFileSync(path.join(repoRoot, "scripts", "sync-e2e-mirror.sh"), "utf8");

    expect(script).toContain("--exclude '.tools/'");
  });

  it("prefers the mirror-local Edge WebDriver tool over stale root or PATH drivers", () => {
    const script = fs.readFileSync(path.join(repoRoot, "scripts", "e2e-smoke-windows.ps1"), "utf8");

    const toolsCandidateIndex = script.indexOf('Join-Path $ProjectRoot ".tools\\windows\\e2e\\msedgedriver.exe"');
    const rootCandidateIndex = script.indexOf('Join-Path $ProjectRoot "msedgedriver.exe"');
    const pathLookupIndex = script.indexOf('Get-Command "msedgedriver.exe"');

    expect(toolsCandidateIndex).toBeGreaterThanOrEqual(0);
    expect(rootCandidateIndex).toBeGreaterThanOrEqual(0);
    expect(pathLookupIndex).toBeGreaterThanOrEqual(0);
    expect(toolsCandidateIndex).toBeLessThan(rootCandidateIndex);
    expect(toolsCandidateIndex).toBeLessThan(pathLookupIndex);
  });

  it("runs Windows E2E projects sequentially when no single project is selected", () => {
    const script = fs.readFileSync(path.join(repoRoot, "scripts", "e2e-smoke-windows.ps1"), "utf8");

    expect(script).toContain("$allProjects = @(");
    expect(script).toContain("foreach ($projectName in $allProjects)");
    expect(script).toContain('@("--project", $projectName)');
  });

  it("falls back to the default Windows PowerShell path from WSL", () => {
    const script = fs.readFileSync(path.join(repoRoot, "scripts", "e2e-smoke-windows.sh"), "utf8");

    expect(script).toContain("command -v powershell.exe");
    expect(script).toContain("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe");
    expect(script).toContain('"$POWERSHELL_EXE" -NoProfile');
  });
});
