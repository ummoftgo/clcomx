import { describe, expect, it } from "vitest";

import { consumeAuxShellMetadata } from "./aux-shell-metadata";

function encodeBase64(value: string) {
  return btoa(new TextEncoder().encode(value).reduce((result, byte) => result + String.fromCharCode(byte), ""));
}

describe("consumeAuxShellMetadata", () => {
  it("extracts cwd metadata and strips it from terminal output", () => {
    const cwd = "/home/tester/workspace";
    const marker = `\u001b]633;CLCOMX_CWD;${encodeBase64(cwd)}\u0007`;
    const result = consumeAuxShellMetadata(`hello\r\n${marker}prompt$ `);

    expect(result.cwd).toBe(cwd);
    expect(result.text).toBe("hello\r\nprompt$ ");
    expect(result.remainder).toBe("");
  });

  it("keeps incomplete metadata in remainder until the next chunk arrives", () => {
    const cwd = "/home/tester/project";
    const encoded = encodeBase64(cwd);
    const first = consumeAuxShellMetadata(`before\u001b]633;CLCOMX_CWD;${encoded.slice(0, 6)}`);
    expect(first.cwd).toBeNull();
    expect(first.text).toBe("before");
    expect(first.remainder).toContain("\u001b]633;CLCOMX_CWD;");

    const second = consumeAuxShellMetadata(`${encoded.slice(6)}\u0007after`, first.remainder);
    expect(second.cwd).toBe(cwd);
    expect(second.text).toBe("after");
    expect(second.remainder).toBe("");
  });

  it("supports ST-terminated OSC sequences", () => {
    const cwd = "/mnt/c/workspace";
    const marker = `\u001b]633;CLCOMX_CWD;${encodeBase64(cwd)}\u001b\\`;
    const result = consumeAuxShellMetadata(marker);

    expect(result.cwd).toBe(cwd);
    expect(result.text).toBe("");
  });
});
