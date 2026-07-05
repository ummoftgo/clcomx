/**
 * markdown-renderer 테스트(Slice ③) — sanitize 화이트리스트·링크 정책·원격 로딩 차단 검증.
 * 입력은 redaction 이후 문자열이라는 규약이므로 여기서는 sanitize/서식 경계만 다룬다.
 */

import { describe, expect, it } from "vitest";
import { renderAgentMarkdown } from "./markdown-renderer";

describe("renderAgentMarkdown", () => {
  it("GFM 기본 서식(강조/인라인 코드/리스트/코드펜스)을 렌더한다", () => {
    const html = renderAgentMarkdown("**bold** `inline`\n\n- item\n\n```ts\nconst a = 1;\n```");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>inline</code>");
    expect(html).toContain("<li>item</li>");
    expect(html).toContain("<pre>");
    expect(html).toContain("const a = 1;");
  });

  it("script/이벤트 핸들러/javascript: 링크를 제거한다(XSS)", () => {
    const html = renderAgentMarkdown(
      '<script>alert(1)</script> <a href="javascript:alert(1)" onclick="x()">x</a> <div onmouseover="y()">d</div>',
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("onmouseover");
  });

  it("img 등 원격 리소스 로딩 태그를 차단한다(privacy leak 방지)", () => {
    const html = renderAgentMarkdown(
      '![alt](https://evil.example/x.png)\n\n<img src="https://evil.example/y.png"><iframe src="https://evil.example"></iframe>',
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("evil.example/x.png");
  });

  it("링크에 새 창 + noopener/noreferrer를 강제한다", () => {
    const html = renderAgentMarkdown("[link](https://example.com/docs)");
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("표를 허용한다(GFM table)", () => {
    const html = renderAgentMarkdown("| a | b |\n| - | - |\n| 1 | 2 |");
    expect(html).toContain("<table");
    expect(html).toContain("<th");
    expect(html).toContain("<td");
  });

  it("data-*/aria-* 속성을 제거한다(transcript anchor·testid 충돌 방지)", () => {
    const html = renderAgentMarkdown(
      '<p data-approval-anchor data-testid="x" aria-label="y">text</p>',
    );
    expect(html).not.toContain("data-approval-anchor");
    expect(html).not.toContain("data-testid");
    expect(html).not.toContain("aria-label");
    expect(html).toContain("text");
  });

  it("mailto:/tel:/protocol-relative 등 non-web scheme 링크를 차단한다", () => {
    const mailto = renderAgentMarkdown("[m](mailto:a@b.com)");
    expect(mailto).not.toContain("mailto:");
    const tel = renderAgentMarkdown("[t](tel:12345)");
    expect(tel).not.toContain("tel:");
    // protocol-relative href도 http/https 정책에 걸려 제거된다.
    const rel = renderAgentMarkdown('<a href="//evil.example/x">x</a>');
    expect(rel).not.toContain("evil.example");
    // http/https는 유지된다.
    expect(renderAgentMarkdown("[o](https://ok.example)")).toContain("https://ok.example");
  });

  it("같은 입력은 캐시로 동일 결과를 재사용한다", () => {
    const first = renderAgentMarkdown("# cached");
    const second = renderAgentMarkdown("# cached");
    expect(second).toBe(first);
  });
});
