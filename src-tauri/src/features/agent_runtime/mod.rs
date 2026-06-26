//! Direct Agent Runtime — backend process/transport 런타임 모듈.
//!
//! 정본: `docs/plans/agent-direct-runtime/07-tauri-process-runtime.md`,
//! 타입은 15 §8, 등록은 BE §3.2. 이 모듈은 protocol 의미를 해석하지 않고
//! raw JSON-RPC framing/transport/lifecycle만 책임진다.
//!
//! NOTE(스캐폴드): 본 모듈은 Phase 2(T2.x)에서 채워지며, 그 전까지 `features/mod.rs`에
//! 등록하지 않는다(미참조 모듈은 컴파일에 포함되지 않음 — T0.1 DoD).

mod allowlist;
mod process;
mod resolver;
mod transport;
mod types;

#[cfg(test)]
mod tests;
