const HOME_DIR_OSC_PREFIX: &str = "\u{1b}]633;CLCOMX_HOME;";
const OSC_BEL_TERMINATOR: &str = "\u{7}";
const OSC_ST_TERMINATOR: &str = "\u{1b}\\";

pub(super) fn strip_ansi_sequences(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut result = String::with_capacity(input.len());
    let mut index = 0usize;

    while index < bytes.len() {
        if bytes[index] != 0x1b {
            if let Some(ch) = input[index..].chars().next() {
                result.push(ch);
                index += ch.len_utf8();
                continue;
            }
            break;
        }

        index += 1;
        if index >= bytes.len() {
            break;
        }

        match bytes[index] {
            b'[' => {
                index += 1;
                while index < bytes.len() {
                    let byte = bytes[index];
                    index += 1;
                    if (0x40..=0x7e).contains(&byte) {
                        break;
                    }
                }
            }
            b']' => {
                index += 1;
                while index < bytes.len() {
                    let byte = bytes[index];
                    index += 1;
                    if byte == 0x07 {
                        break;
                    }
                    if byte == 0x1b && index < bytes.len() && bytes[index] == b'\\' {
                        index += 1;
                        break;
                    }
                }
            }
            _ => {
                index += 1;
            }
        }
    }

    result
}

fn extract_resume_command_token(line: &str, command_prefix: &str) -> Option<String> {
    let Some(index) = line.find(command_prefix) else {
        return None;
    };

    let rest = line[index + command_prefix.len()..].trim_start();
    if rest.is_empty() {
        return None;
    }

    let candidate = if let Some(stripped) = rest.strip_prefix('"') {
        stripped.split('"').next().unwrap_or_default().trim()
    } else if let Some(stripped) = rest.strip_prefix('\'') {
        stripped.split('\'').next().unwrap_or_default().trim()
    } else {
        rest.split_whitespace().next().unwrap_or_default().trim()
    };

    if candidate.is_empty() {
        None
    } else {
        Some(candidate.to_string())
    }
}

pub(super) fn extract_resume_token(output: &str, agent_id: &str) -> Option<String> {
    let command_prefix = match agent_id {
        "codex" => "codex resume",
        _ => "claude --resume",
    };

    let normalized = strip_ansi_sequences(output).replace('\r', "\n");

    for line in normalized.lines().rev() {
        if let Some(candidate) = extract_resume_command_token(line, command_prefix) {
            return Some(candidate);
        }
    }

    None
}

pub(super) fn decode_utf8_stream_chunk(
    pending: &mut Vec<u8>,
    chunk: &[u8],
    flush_incomplete: bool,
) -> String {
    pending.extend_from_slice(chunk);
    let mut output = String::new();
    let mut consumed = 0usize;

    while consumed < pending.len() {
        match std::str::from_utf8(&pending[consumed..]) {
            Ok(valid) => {
                output.push_str(valid);
                consumed = pending.len();
                break;
            }
            Err(err) => {
                let valid_up_to = err.valid_up_to();
                if valid_up_to > 0 {
                    let valid_end = consumed + valid_up_to;
                    let valid = std::str::from_utf8(&pending[consumed..valid_end])
                        .expect("valid_up_to must point to valid UTF-8");
                    output.push_str(valid);
                    consumed = valid_end;
                }

                match err.error_len() {
                    Some(error_len) => {
                        output.push('\u{fffd}');
                        consumed += error_len;
                    }
                    None => {
                        if flush_incomplete {
                            output.push_str(&String::from_utf8_lossy(&pending[consumed..]));
                            consumed = pending.len();
                        }
                        break;
                    }
                }
            }
        }
    }

    if consumed > 0 {
        pending.drain(..consumed);
    }

    output
}

fn decode_base64_utf8(input: &str) -> Option<String> {
    let mut buffer = Vec::with_capacity(input.len().saturating_mul(3) / 4);
    let mut quartet = [0u8; 4];
    let mut quartet_len = 0usize;
    let mut padding = 0usize;

    for byte in input.trim().bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => {
                padding += 1;
                0
            }
            b'\r' | b'\n' | b'\t' | b' ' => continue,
            _ => return None,
        };

        if padding > 0 && byte != b'=' {
            return None;
        }

        quartet[quartet_len] = value;
        quartet_len += 1;

        if quartet_len == 4 {
            buffer.push((quartet[0] << 2) | (quartet[1] >> 4));
            if padding < 2 {
                buffer.push((quartet[1] << 4) | (quartet[2] >> 2));
            }
            if padding == 0 {
                buffer.push((quartet[2] << 6) | quartet[3]);
            }

            quartet = [0; 4];
            quartet_len = 0;
            padding = 0;
        }
    }

    if quartet_len != 0 {
        return None;
    }

    String::from_utf8(buffer).ok()
}

fn find_osc_terminator(source: &str, start: usize) -> Option<(usize, usize)> {
    let bel_index = source[start..]
        .find(OSC_BEL_TERMINATOR)
        .map(|index| start + index);
    let st_index = source[start..]
        .find(OSC_ST_TERMINATOR)
        .map(|index| start + index);

    match (bel_index, st_index) {
        (None, None) => None,
        (Some(index), None) => Some((index, OSC_BEL_TERMINATOR.len())),
        (None, Some(index)) => Some((index, OSC_ST_TERMINATOR.len())),
        (Some(bel), Some(st)) if bel < st => Some((bel, OSC_BEL_TERMINATOR.len())),
        (Some(_), Some(st)) => Some((st, OSC_ST_TERMINATOR.len())),
    }
}

fn longest_partial_prefix_suffix(source: &str, prefix: &str) -> usize {
    let max_len = source.len().min(prefix.len());
    for len in (1..=max_len).rev() {
        if source.ends_with(&prefix[..len]) {
            return len;
        }
    }
    0
}

pub(super) fn consume_home_dir_osc(source: &str, remainder: &str) -> (Option<String>, String) {
    let mut buffer = String::with_capacity(remainder.len() + source.len());
    buffer.push_str(remainder);
    buffer.push_str(source);

    let mut cursor = 0usize;
    let mut home_dir = None;

    while cursor < buffer.len() {
        let Some(offset) = buffer[cursor..].find(HOME_DIR_OSC_PREFIX) else {
            break;
        };
        let start = cursor + offset;
        let payload_start = start + HOME_DIR_OSC_PREFIX.len();

        let Some((terminator_index, terminator_len)) = find_osc_terminator(&buffer, payload_start)
        else {
            return (home_dir, buffer[start..].to_string());
        };

        if let Some(decoded) = decode_base64_utf8(&buffer[payload_start..terminator_index]) {
            home_dir = Some(decoded);
        }

        cursor = terminator_index + terminator_len;
    }

    let tail = &buffer[cursor..];
    let suffix_len = longest_partial_prefix_suffix(tail, HOME_DIR_OSC_PREFIX);
    (
        home_dir,
        tail[tail.len().saturating_sub(suffix_len)..].to_string(),
    )
}
