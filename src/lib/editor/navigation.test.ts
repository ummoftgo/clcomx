import { describe, expect, it, vi } from "vitest";
import {
  collectHeuristicDocumentSymbols,
  findFastHeuristicDefinition,
  findHeuristicDefinition,
  findLineFastHeuristicDefinition,
  type NavigationFileSnapshot,
} from "./navigation";

describe("editor navigation heuristics", () => {
  it("follows imported JS/TS symbols into relative files", async () => {
    const readWorkspaceFile = vi.fn<
      (wslPath: string) => Promise<NavigationFileSnapshot>
    >(async (wslPath) => ({
      wslPath,
      languageId: "typescript",
      content: "export function sum(a: number, b: number) {\n  return a + b;\n}\n",
    }));

    const location = await findHeuristicDefinition({
      modelPath: "/home/user/work/project/src/index.ts",
      languageId: "typescript",
      content:
        'import { sum as add } from "./lib/math";\n' +
        "const total = add(1, 2);\n",
      lineNumber: 2,
      column: 16,
      workspaceRoot: "/home/user/work/project",
      workspaceFiles: [
        {
          wslPath: "/home/user/work/project/src/lib/math.ts",
          relativePath: "src/lib/math.ts",
          basename: "math.ts",
        },
      ],
      readWorkspaceFile,
    });

    expect(location).toEqual({
      wslPath: "/home/user/work/project/src/lib/math.ts",
      line: 1,
      column: 17,
    });
  });

  it("resolves PHP use aliases to workspace class files", async () => {
    const readWorkspaceFile = vi.fn<
      (wslPath: string) => Promise<NavigationFileSnapshot>
    >(async (wslPath) => ({
      wslPath,
      languageId: "php",
      content:
        "<?php\n" +
        "namespace App\\Support;\n\n" +
        "class GreetingService\n" +
        "{\n}\n",
    }));

    const location = await findHeuristicDefinition({
      modelPath: "/home/user/work/project/app/Http/Controller.php",
      languageId: "php",
      content:
        "<?php\n" +
        "use App\\Support\\GreetingService;\n\n" +
        "$service = new GreetingService();\n",
      lineNumber: 4,
      column: 24,
      workspaceRoot: "/home/user/work/project",
      workspaceFiles: [
        {
          wslPath: "/home/user/work/project/app/Support/GreetingService.php",
          relativePath: "app/Support/GreetingService.php",
          basename: "GreetingService.php",
        },
      ],
      readWorkspaceFile,
    });

    expect(location).toEqual({
      wslPath: "/home/user/work/project/app/Support/GreetingService.php",
      line: 4,
      column: 7,
    });
  });

  it("finds current-file PHP function definitions without reading another file", async () => {
    const readWorkspaceFile = vi.fn();
    const location = await findHeuristicDefinition({
      modelPath: "/home/user/work/project/app/helpers.php",
      languageId: "php",
      content: "<?php\nfunction greet() {}\n\ngreet();\n",
      lineNumber: 4,
      column: 3,
      workspaceRoot: "/home/user/work/project",
      workspaceFiles: [],
      readWorkspaceFile,
    });

    expect(location).toEqual({
      wslPath: "/home/user/work/project/app/helpers.php",
      line: 2,
      column: 10,
    });
    expect(readWorkspaceFile).not.toHaveBeenCalled();
  });

  it("follows relative path strings under the cursor", async () => {
    const location = await findHeuristicDefinition({
      modelPath: "/home/user/work/project/src/routes.ts",
      languageId: "typescript",
      content: 'export { page } from "./pages/home";\n',
      lineNumber: 1,
      column: 24,
      workspaceRoot: "/home/user/work/project",
      workspaceFiles: [
        {
          wslPath: "/home/user/work/project/src/pages/home.ts",
          relativePath: "src/pages/home.ts",
          basename: "home.ts",
        },
      ],
      readWorkspaceFile: vi.fn(),
    });

    expect(location).toEqual({
      wslPath: "/home/user/work/project/src/pages/home.ts",
      line: 1,
      column: 1,
    });
  });

  it("resolves bare PHP include filenames relative to the current file", async () => {
    const location = await findHeuristicDefinition({
      modelPath: "/home/user/work/project/app/bootstrap.php",
      languageId: "php",
      content: "<?php\nrequire 'helpers.php';\n",
      lineNumber: 2,
      column: 12,
      workspaceRoot: "/home/user/work/project",
      workspaceFiles: [
        {
          wslPath: "/home/user/work/project/app/helpers.php",
          relativePath: "app/helpers.php",
          basename: "helpers.php",
        },
      ],
      readWorkspaceFile: vi.fn(),
    });

    expect(location).toEqual({
      wslPath: "/home/user/work/project/app/helpers.php",
      line: 1,
      column: 1,
    });
  });

  it("resolves PHP __DIR__ include concatenations", async () => {
    const location = await findHeuristicDefinition({
      modelPath: "/home/user/work/project/app/bootstrap.php",
      languageId: "php",
      content: "<?php\nrequire __DIR__ . '/Support/helpers.php';\n",
      lineNumber: 2,
      column: 23,
      workspaceRoot: "/home/user/work/project",
      workspaceFiles: [
        {
          wslPath: "/home/user/work/project/app/Support/helpers.php",
          relativePath: "app/Support/helpers.php",
          basename: "helpers.php",
        },
      ],
      readWorkspaceFile: vi.fn(),
    });

    expect(location).toEqual({
      wslPath: "/home/user/work/project/app/Support/helpers.php",
      line: 1,
      column: 1,
    });
  });

  it("resolves dirname(__DIR__) PHP include concatenations", async () => {
    const location = await findHeuristicDefinition({
      modelPath: "/home/user/work/project/app/Http/Controller.php",
      languageId: "php",
      content: "<?php\nrequire dirname(__DIR__) . '/Support/helpers.php';\n",
      lineNumber: 2,
      column: 31,
      workspaceRoot: "/home/user/work/project",
      workspaceFiles: [
        {
          wslPath: "/home/user/work/project/app/Support/helpers.php",
          relativePath: "app/Support/helpers.php",
          basename: "helpers.php",
        },
      ],
      readWorkspaceFile: vi.fn(),
    });

    expect(location).toEqual({
      wslPath: "/home/user/work/project/app/Support/helpers.php",
      line: 1,
      column: 1,
    });
  });

  it("resolves dirname(__FILE__) PHP include concatenations", async () => {
    const location = await findHeuristicDefinition({
      modelPath: "/home/user/work/project/app/bootstrap.php",
      languageId: "php",
      content: "<?php\nrequire dirname(__FILE__) . '/Support/helpers.php';\n",
      lineNumber: 2,
      column: 33,
      workspaceRoot: "/home/user/work/project",
      workspaceFiles: [
        {
          wslPath: "/home/user/work/project/app/Support/helpers.php",
          relativePath: "app/Support/helpers.php",
          basename: "helpers.php",
        },
      ],
      readWorkspaceFile: vi.fn(),
    });

    expect(location).toEqual({
      wslPath: "/home/user/work/project/app/Support/helpers.php",
      line: 1,
      column: 1,
    });
  });

  it("resolves nested dirname PHP include concatenations", async () => {
    const location = await findHeuristicDefinition({
      modelPath: "/home/user/work/project/app/Http/Controllers/HomeController.php",
      languageId: "php",
      content: "<?php\nrequire dirname(dirname(__DIR__)) . '/Support/helpers.php';\n",
      lineNumber: 2,
      column: 40,
      workspaceRoot: "/home/user/work/project",
      workspaceFiles: [
        {
          wslPath: "/home/user/work/project/app/Support/helpers.php",
          relativePath: "app/Support/helpers.php",
          basename: "helpers.php",
        },
      ],
      readWorkspaceFile: vi.fn(),
    });

    expect(location).toEqual({
      wslPath: "/home/user/work/project/app/Support/helpers.php",
      line: 1,
      column: 1,
    });
  });

  it("resolves multi-part PHP include concatenations", async () => {
    const location = await findHeuristicDefinition({
      modelPath: "/home/user/work/project/app/bootstrap.php",
      languageId: "php",
      content: "<?php\nrequire __DIR__ . '/../views/' . 'header.php';\n",
      lineNumber: 2,
      column: 36,
      workspaceRoot: "/home/user/work/project",
      workspaceFiles: [
        {
          wslPath: "/home/user/work/project/views/header.php",
          relativePath: "views/header.php",
          basename: "header.php",
        },
      ],
      readWorkspaceFile: vi.fn(),
    });

    expect(location).toEqual({
      wslPath: "/home/user/work/project/views/header.php",
      line: 1,
      column: 1,
    });
  });

  it("resolves parenthesized PHP require expressions", async () => {
    const location = await findHeuristicDefinition({
      modelPath: "/home/user/work/project/app/bootstrap.php",
      languageId: "php",
      content: "<?php\nrequire_once(__DIR__ . '/Support/helpers.php');\n",
      lineNumber: 2,
      column: 28,
      workspaceRoot: "/home/user/work/project",
      workspaceFiles: [
        {
          wslPath: "/home/user/work/project/app/Support/helpers.php",
          relativePath: "app/Support/helpers.php",
          basename: "helpers.php",
        },
      ],
      readWorkspaceFile: vi.fn(),
    });

    expect(location).toEqual({
      wslPath: "/home/user/work/project/app/Support/helpers.php",
      line: 1,
      column: 1,
    });
  });

  it("treats leading slash PHP include paths as absolute", async () => {
    const location = await findHeuristicDefinition({
      modelPath: "/home/user/work/project/app/bootstrap.php",
      languageId: "php",
      content: "<?php\nrequire '/shared/helpers.php';\n",
      lineNumber: 2,
      column: 15,
      workspaceRoot: "/home/user/work/project",
      workspaceFiles: [
        {
          wslPath: "/shared/helpers.php",
          relativePath: "../../shared/helpers.php",
          basename: "helpers.php",
        },
        {
          wslPath: "/home/user/work/project/app/shared/helpers.php",
          relativePath: "app/shared/helpers.php",
          basename: "helpers.php",
        },
      ],
      readWorkspaceFile: vi.fn(),
    });

    expect(location).toEqual({
      wslPath: "/shared/helpers.php",
      line: 1,
      column: 1,
    });
  });

  it("collects Svelte script symbols for outline navigation", () => {
    const symbols = collectHeuristicDocumentSymbols(
      [
        "<script lang=\"ts\">",
        "  export let title = '';",
        "  function greet() {}",
        "  const count = 0;",
        "</script>",
        "",
        "<h1>{title}</h1>",
      ].join("\n"),
      "svelte",
    );

    expect(symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "title", kind: "variable", line: 2 }),
        expect.objectContaining({ name: "greet", kind: "function", line: 3 }),
        expect.objectContaining({ name: "count", kind: "variable", line: 4 }),
      ]),
    );
  });

  it("finds fast PHP include targets without workspace indexing", () => {
    const location = findFastHeuristicDefinition({
      modelPath: "/home/user/work/project/app/bootstrap.php",
      languageId: "php",
      content: "<?php\nrequire __DIR__ . '/Support/helpers.php';\n",
      lineNumber: 2,
      column: 24,
      workspaceRoot: "/home/user/work/project",
    });

    expect(location).toEqual({
      wslPath: "/home/user/work/project/app/Support/helpers.php",
      line: 1,
      column: 1,
    });
  });

  it("finds fast current-file PHP symbols without workspace indexing", () => {
    const location = findFastHeuristicDefinition({
      modelPath: "/home/user/work/project/app/helpers.php",
      languageId: "php",
      content: "<?php\nfunction greet() {}\n\ngreet();\n",
      lineNumber: 4,
      column: 3,
      workspaceRoot: "/home/user/work/project",
    });

    expect(location).toEqual({
      wslPath: "/home/user/work/project/app/helpers.php",
      line: 2,
      column: 10,
    });
  });

  it("finds fast JS import path targets with explicit extensions", () => {
    const location = findFastHeuristicDefinition({
      modelPath: "/home/user/work/project/src/index.ts",
      languageId: "typescript",
      content: 'import "./lib/math.ts";\n',
      lineNumber: 1,
      column: 12,
      workspaceRoot: "/home/user/work/project",
    });

    expect(location).toEqual({
      wslPath: "/home/user/work/project/src/lib/math.ts",
      line: 1,
      column: 1,
    });
  });

  it("finds line-fast PHP include targets from current line only", () => {
    const location = findLineFastHeuristicDefinition({
      modelPath: "/home/user/work/project/app/bootstrap.php",
      languageId: "php",
      lineContent: "require __DIR__ . '/Support/helpers.php';",
      lineNumber: 1,
      column: 21,
      workspaceRoot: "/home/user/work/project",
    });

    expect(location).toEqual({
      wslPath: "/home/user/work/project/app/Support/helpers.php",
      line: 1,
      column: 1,
    });
  });
});
