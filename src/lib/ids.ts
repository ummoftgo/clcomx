function randomSegment() {
  return Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, "0");
}

export function createRuntimeId(prefix = "") {
  const base =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(16)}-${randomSegment()}-${randomSegment()}`;
  return prefix ? `${prefix}${base}` : base;
}
