/**
 * agent transcript markdown 렌더러(TB-4 표시 경계 하위, 설계 논의 20260705 Slice ③).
 *
 * 순서 고정: **redaction(호출자) → marked 파싱 → DOMPurify sanitize → {@html}**.
 * - 입력은 반드시 `redactDisplayText`를 통과한 문자열이어야 한다(비밀 마스킹 선행).
 * - `img` 등 원격 리소스 로딩 태그는 차단한다(privacy leak). script/이벤트 핸들러는 sanitize가 제거.
 * - 링크는 새 창 + `noopener noreferrer`를 강제한다.
 * - 스트리밍 중에는 호출하지 않는다(완성 item 1회 파싱) — 호출자(MessageBubble) 규약.
 */

import DOMPurify from "dompurify";
import { marked } from "marked";

marked.setOptions({ gfm: true, breaks: true });

// 화이트리스트 방식: transcript에 필요한 서식 태그만 허용한다. img/video/iframe/svg/form 등
// 원격 로딩·상호작용 표면은 목록에 없으므로 제거된다(GFM task list의 input checkbox 포함 —
// 체크박스는 텍스트 마커로 대신 남는다).
const ALLOWED_TAGS = [
  "p",
  "br",
  "hr",
  "strong",
  "em",
  "del",
  "code",
  "pre",
  "blockquote",
  "ul",
  "ol",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "a",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
];

const ALLOWED_ATTR = ["href", "title", "class", "align", "start"];

// 링크 scheme은 기존 terminal link 정책과 동일하게 http/https만 허용한다(mailto:/tel:/cid:/
// protocol-relative/relative 등 DOMPurify 기본 통과 scheme 차단). 앵커 텍스트는 sanitize가 유지한다.
const ALLOWED_URI_REGEXP = /^https?:\/\//i;

let linkHookRegistered = false;

/** 링크를 새 창 + noopener/noreferrer로 강제하는 sanitize 훅(1회 등록). */
function ensureLinkHook(): void {
  if (linkHookRegistered) return;
  linkHookRegistered = true;
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  });
}

// item 완성 후 1회 파싱이 원칙이지만 keyed 재마운트가 있으므로 결과를 bounded 캐시로 재사용한다.
const CACHE_MAX = 200;
const cache = new Map<string, string>();

/**
 * redaction을 마친 markdown 텍스트를 sanitize된 HTML로 변환한다.
 * 반환값은 `{@html}`에 바로 넣을 수 있는 신뢰 HTML이다(DOMPurify 통과분).
 */
export function renderAgentMarkdown(redactedText: string): string {
  const hit = cache.get(redactedText);
  if (hit !== undefined) return hit;

  ensureLinkHook();
  const parsed = marked.parse(redactedText, { async: false }) as string;
  const html = DOMPurify.sanitize(parsed, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    // 기본값을 이 표면에 맞게 잠근다: data-*/aria-* 속성 금지(transcript의 data-* anchor·
    // testid와 충돌 방지), 링크 scheme은 http/https만(위 정책).
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    ALLOWED_URI_REGEXP,
  });

  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(redactedText, html);
  return html;
}
