import { describe, expect, it } from "vitest";
import { parseJsImports } from "./js-imports";

describe("navigation JS imports", () => {
  it("parses default, named, namespace, and re-export bindings", () => {
    expect(
      parseJsImports(
        [
          'import React from "react";',
          'import { sum as add, subtract } from "./math";',
          'import * as fs from "node:fs";',
          'export { page as homePage } from "./pages/home";',
        ].join("\n"),
        "typescript",
      ),
    ).toEqual([
      { localName: "React", importedName: "default", source: "react" },
      { localName: "add", importedName: "sum", source: "./math" },
      { localName: "subtract", importedName: "subtract", source: "./math" },
      { localName: "fs", importedName: "*", source: "node:fs" },
      { localName: "homePage", importedName: "page", source: "./pages/home" },
    ]);
  });

  it("parses imports from Svelte script blocks only", () => {
    expect(
      parseJsImports(
        [
          '<script lang="ts">',
          '  import { inside } from "./inside";',
          "</script>",
          '<div>{outside}</div>',
          'import { outside } from "./outside";',
        ].join("\n"),
        "svelte",
      ),
    ).toEqual([
      { localName: "inside", importedName: "inside", source: "./inside" },
    ]);
  });
});
