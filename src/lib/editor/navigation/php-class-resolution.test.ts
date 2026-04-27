import { describe, expect, it } from "vitest";
import {
  parsePhpUses,
  resolvePhpClassPath,
  scorePhpWorkspaceCandidate,
} from "./php-class-resolution";

describe("navigation PHP class resolution", () => {
  it("parses simple, aliased, comma-separated, and leading-slash use bindings", () => {
    expect(
      parsePhpUses(
        [
          "<?php",
          "use \\App\\Support\\GreetingService;",
          "use App\\Support\\Logger as Log;",
          "use App\\A\\One, App\\B\\Two as Second;",
        ].join("\n"),
      ),
    ).toEqual([
      { alias: "GreetingService", fqcn: "App\\Support\\GreetingService" },
      { alias: "Log", fqcn: "App\\Support\\Logger" },
      { alias: "One", fqcn: "App\\A\\One" },
      { alias: "Second", fqcn: "App\\B\\Two" },
    ]);
  });

  it("keeps grouped PHP use statements unsupported", () => {
    expect(parsePhpUses("<?php\nuse App\\Support\\{One, Two};\n")).toEqual([]);
  });

  it("prefers explicit namespace path matches", () => {
    const resolved = resolvePhpClassPath("App\\Support\\GreetingService", "/repo", [
      {
        wslPath: "/repo/legacy/GreetingService.php",
        relativePath: "legacy/GreetingService.php",
        basename: "GreetingService.php",
      },
      {
        wslPath: "/repo/App/Support/GreetingService.php",
        relativePath: "App/Support/GreetingService.php",
        basename: "GreetingService.php",
      },
    ]);

    expect(resolved).toBe("/repo/App/Support/GreetingService.php");
  });

  it("prefers namespace suffix candidates over basename-only candidates", () => {
    const resolved = resolvePhpClassPath("App\\Support\\GreetingService", "/repo", [
      {
        wslPath: "/repo/legacy/GreetingService.php",
        relativePath: "legacy/GreetingService.php",
        basename: "GreetingService.php",
      },
      {
        wslPath: "/repo/src/App/Support/GreetingService.php",
        relativePath: "src/App/Support/GreetingService.php",
        basename: "GreetingService.php",
      },
    ]);

    expect(resolved).toBe("/repo/src/App/Support/GreetingService.php");
  });

  it("scores namespace suffix matches ahead of basename-only candidates", () => {
    expect(
      scorePhpWorkspaceCandidate("App/Support/GreetingService.php", "App/Support/GreetingService"),
    ).toBe(0);
    expect(
      scorePhpWorkspaceCandidate(
        "src/App/Support/GreetingService.php",
        "App/Support/GreetingService",
      ),
    ).toBe(1);
    expect(
      scorePhpWorkspaceCandidate("legacy\\GreetingService.php", "App/Support/GreetingService"),
    ).toBe(2);
    expect(
      scorePhpWorkspaceCandidate("vendor/Other/Logger.php", "App/Support/GreetingService"),
    ).toBeGreaterThan(2);
  });

  it("uses stable relative path ordering when candidates have the same score", () => {
    const resolved = resolvePhpClassPath("GreetingService", "/repo", [
      {
        wslPath: "/repo/z/GreetingService.php",
        relativePath: "z/GreetingService.php",
        basename: "GreetingService.php",
      },
      {
        wslPath: "/repo/a/GreetingService.php",
        relativePath: "a/GreetingService.php",
        basename: "GreetingService.php",
      },
    ]);

    expect(resolved).toBe("/repo/a/GreetingService.php");
  });
});
