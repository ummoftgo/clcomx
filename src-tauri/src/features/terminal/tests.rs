use super::parsing::{
    consume_home_dir_osc, decode_utf8_stream_chunk, extract_resume_token, strip_ansi_sequences,
};
use super::{
    get_output_delta_since, get_output_snapshot, get_runtime_snapshot, test_state_with_session,
};

#[test]
fn extract_resume_token_matches_claude_forms() {
    assert_eq!(
        extract_resume_token(
            "Resume this session with:\nclaude --resume \"abc-123\"",
            "claude"
        ),
        Some("abc-123".into())
    );
    assert_eq!(
        extract_resume_token("claude --resume 'abc-456'", "claude"),
        Some("abc-456".into())
    );
    assert_eq!(
        extract_resume_token(
            "claude --resume 267c4d37-d196-4f64-a44d-a6dd884645d3",
            "claude"
        ),
        Some("267c4d37-d196-4f64-a44d-a6dd884645d3".into())
    );
}

#[test]
fn extract_resume_token_matches_codex_forms() {
    assert_eq!(
        extract_resume_token(
            "To continue this session, run codex resume '스킬연구'",
            "codex",
        ),
        Some("스킬연구".into())
    );
    assert_eq!(
        extract_resume_token(
            "To continue this session, run codex resume 019c9fe6-12fa-7272-a1b0-e541b71f608c",
            "codex",
        ),
        Some("019c9fe6-12fa-7272-a1b0-e541b71f608c".into())
    );
}

#[test]
fn strip_ansi_sequences_removes_control_codes() {
    let raw = "\u{1b}[1mTo continue this session, run codex resume 'token-123'\u{1b}[0m";
    assert_eq!(
        strip_ansi_sequences(raw),
        "To continue this session, run codex resume 'token-123'"
    );
}

#[test]
fn extract_resume_token_matches_codex_forms_with_ansi() {
    let raw = "\u{1b}[32mTo continue this session, run codex resume '스킬연구'\u{1b}[0m";
    assert_eq!(extract_resume_token(raw, "codex"), Some("스킬연구".into()));
}

#[test]
fn decode_utf8_stream_chunk_preserves_split_multibyte_codepoints() {
    let mut pending = Vec::new();
    let prefix = "• 골드마인 주소를 바로 확인하겠";
    let split = "습".as_bytes();
    let suffix = "니다. 응답 헤더만 확인해서 현재 접속 기준 URL을 정리합니다.";

    assert_eq!(
        decode_utf8_stream_chunk(&mut pending, prefix.as_bytes(), false),
        prefix
    );
    assert_eq!(
        decode_utf8_stream_chunk(&mut pending, &split[..2], false),
        ""
    );
    assert_eq!(
        decode_utf8_stream_chunk(&mut pending, &split[2..], false),
        "습"
    );
    assert_eq!(
        decode_utf8_stream_chunk(&mut pending, suffix.as_bytes(), false),
        suffix
    );
    assert!(pending.is_empty());
}

#[test]
fn decode_utf8_stream_chunk_replaces_invalid_sequences_and_recovers() {
    let mut pending = Vec::new();
    assert_eq!(
        decode_utf8_stream_chunk(&mut pending, &[b'f', 0x80, b'g'], false),
        "f\u{fffd}g"
    );
    assert!(pending.is_empty());
}

#[test]
fn decode_utf8_stream_chunk_flushes_incomplete_trailing_bytes_on_stream_end() {
    let mut pending = Vec::new();
    let split = "습".as_bytes();

    assert_eq!(
        decode_utf8_stream_chunk(&mut pending, &split[..2], false),
        ""
    );
    assert_eq!(
        decode_utf8_stream_chunk(&mut pending, &[], true),
        "\u{fffd}"
    );
    assert!(pending.is_empty());
}

#[test]
fn consume_home_dir_osc_preserves_split_prefix_and_terminator() {
    let first = "\u{1b}]633;CLCOMX_HO";
    let second = "ME;L2hvbWUvdGVzdGVy";
    let third = "\u{7}rest";

    let (home_dir, remainder) = consume_home_dir_osc(first, "");
    assert_eq!(home_dir, None);
    assert_eq!(remainder, first);

    let (home_dir, remainder) = consume_home_dir_osc(second, &remainder);
    assert_eq!(home_dir, None);
    assert_eq!(remainder, format!("{}{}", first, second));

    let (home_dir, remainder) = consume_home_dir_osc(third, &remainder);
    assert_eq!(home_dir.as_deref(), Some("/home/tester"));
    assert_eq!(remainder, "");
}

#[test]
fn snapshot_helpers_include_cached_home_directory() {
    let state = test_state_with_session(11, &[(1, "alpha")], 1, 120, 36, Some("/home/tester"));

    let output = get_output_snapshot(&state, 11).expect("output snapshot should succeed");
    assert_eq!(output.home_dir.as_deref(), Some("/home/tester"));

    let runtime = get_runtime_snapshot(&state, 11).expect("runtime snapshot should succeed");
    assert_eq!(runtime.home_dir.as_deref(), Some("/home/tester"));
}

#[test]
fn get_output_delta_since_returns_complete_data_when_requested_seq_is_still_buffered() {
    let state = test_state_with_session(
        7,
        &[(3, "alpha"), (4, "beta"), (5, "gamma")],
        5,
        120,
        36,
        None,
    );

    let delta = get_output_delta_since(&state, 7, 3).expect("delta lookup should succeed");

    assert!(delta.complete);
    assert_eq!(delta.seq, 5);
    assert_eq!(delta.data, "betagamma");
}

#[test]
fn get_output_delta_since_marks_gap_when_requested_seq_fell_out_of_chunk_buffer() {
    let state = test_state_with_session(9, &[(8, "recent"), (9, "tail")], 9, 120, 36, None);

    let delta = get_output_delta_since(&state, 9, 6).expect("delta lookup should succeed");

    assert!(!delta.complete);
    assert_eq!(delta.seq, 9);
    assert_eq!(delta.data, "");
}
