#!/usr/bin/env python3
import argparse
import base64
import json
import os
import pty
import select
import subprocess
import sys
import threading
import time


TMUX_CONTROL_START = "\x1bP1000p"
TMUX_CONTROL_END = "\x1b\\"
STRUCTURAL_STATE_COALESCE_SEC = 0.05


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def tmux_output(args):
    completed = subprocess.run(
        ["tmux", *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError((completed.stderr or completed.stdout or "tmux command failed").strip())
    return completed.stdout


def has_session(session_name):
    completed = subprocess.run(
        ["tmux", "has-session", "-t", session_name],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    return completed.returncode == 0


def decode_field(value):
    return base64.b64decode(value.encode("ascii")).decode("utf-8", errors="replace")


def capture_snapshot(session_name, history_lines):
    if not has_session(session_name):
        return None

    session_line = tmux_output(
        ["display-message", "-p", "-t", session_name, "#{session_name}\t#{window_width}\t#{window_height}"]
    ).strip()
    active_pane_id = (
        tmux_output(["list-panes", "-t", session_name, "-F", "#{?pane_active,#{pane_id},}"])
        .splitlines()
    )
    active_pane_id = next((line for line in active_pane_id if line.strip()), None)
    if not active_pane_id:
        first = tmux_output(["list-panes", "-t", session_name, "-F", "#{pane_id}"]).splitlines()
        active_pane_id = first[0].strip() if first else ""

    session_name_value, width, height = session_line.split("\t", 2)

    panes = []
    pane_lines = tmux_output(
        [
            "list-panes",
            "-t",
            session_name,
            "-F",
            "#{pane_id}\t#{pane_active}\t#{pane_dead}\t#{pane_left}\t#{pane_top}\t#{pane_width}\t#{pane_height}\t#{cursor_x}\t#{cursor_y}\t#{pane_current_path}\t#{pane_current_command}",
        ]
    ).splitlines()

    for line in pane_lines:
        if not line.strip():
            continue
        (
            pane_id,
            pane_active,
            pane_dead,
            pane_left,
            pane_top,
            pane_width,
            pane_height,
            cursor_x,
            cursor_y,
            current_path,
            current_command,
        ) = line.split("\t", 10)
        history_text = ""
        if history_lines > 0:
            start = f"-{max(history_lines, 0)}"
            history_text = tmux_output(["capture-pane", "-p", "-N", "-e", "-S", start, "-E", "-1", "-t", pane_id])
        screen_text = tmux_output(["capture-pane", "-p", "-N", "-e", "-t", pane_id])
        panes.append(
            {
                "paneId": pane_id,
                "active": pane_active == "1",
                "dead": pane_dead == "1",
                "left": int(pane_left or 0),
                "top": int(pane_top or 0),
                "width": int(pane_width or 0),
                "height": int(pane_height or 0),
                "cursorX": int(cursor_x or 0),
                "cursorY": int(cursor_y or 0),
                "currentPath": current_path,
                "currentCommand": current_command,
                "historyText": history_text,
                "screenText": screen_text,
            }
        )

    return {
        "sessionName": session_name_value,
        "activePaneId": active_pane_id or "",
        "width": int(width or 0),
        "height": int(height or 0),
        "panes": panes,
    }


def capture_snapshot_with_size_wait(session_name, history_lines, cols, rows, attempts=8, delay=0.05):
    target_cols = max(int(cols or 0), 60)
    target_rows = max(int(rows or 0), 16)
    latest = None
    for attempt in range(max(attempts, 1)):
        latest = capture_snapshot(session_name, history_lines)
        if latest and latest.get("width") == target_cols and latest.get("height") == target_rows:
            return latest
        if attempt < attempts - 1:
            time.sleep(delay)
    return latest


def unescape_tmux_output(raw):
    result = bytearray()
    index = 0
    raw_bytes = raw.encode("utf-8", errors="replace")
    while index < len(raw_bytes):
        value = raw_bytes[index]
        if value != 0x5C:
            result.append(value)
            index += 1
            continue
        index += 1
        if index >= len(raw_bytes):
            result.append(0x5C)
            break
        escaped = raw_bytes[index]
        if escaped == 0x5C:
            result.append(0x5C)
            index += 1
        elif escaped == ord("n"):
            result.append(0x0A)
            index += 1
        elif escaped == ord("r"):
            result.append(0x0D)
            index += 1
        elif escaped == ord("t"):
            result.append(0x09)
            index += 1
        elif 0x30 <= escaped <= 0x37:
            digits = []
            count = 0
            while index < len(raw_bytes) and count < 3 and 0x30 <= raw_bytes[index] <= 0x37:
                digits.append(chr(raw_bytes[index]))
                index += 1
                count += 1
            result.append(int("".join(digits), 8) & 0xFF)
        else:
            result.append(escaped)
            index += 1
    return result.decode("utf-8", errors="replace")


def split_control_messages(pending):
    messages = []
    while True:
        if pending.startswith(TMUX_CONTROL_START):
            pending = pending[len(TMUX_CONTROL_START) :]
            continue
        if pending.startswith(TMUX_CONTROL_END):
            pending = pending[len(TMUX_CONTROL_END) :]
            continue

        start = pending.find(TMUX_CONTROL_START)
        if start > 0:
            prefix = pending[:start]
            pending = pending[start:]
            messages.extend([line for line in prefix.replace("\r", "\n").split("\n") if line])
            continue

        end = pending.find(TMUX_CONTROL_END)
        if end > 0:
            prefix = pending[:end]
            pending = pending[end + len(TMUX_CONTROL_END) :]
            messages.extend([line for line in prefix.replace("\r", "\n").split("\n") if line])
            continue

        newline_index = min([idx for idx in [pending.find("\n"), pending.find("\r")] if idx != -1], default=-1)
        if newline_index == -1:
            break
        line = pending[:newline_index]
        consume = newline_index
        while consume < len(pending) and pending[consume] in ("\n", "\r"):
            consume += 1
        pending = pending[consume:]
        if line:
            messages.append(line)
    return messages, pending


def is_structural_event(line):
    prefix = line.split(" ", 1)[0]
    return prefix in {
        "%layout-change",
        "%window-pane-changed",
        "%window-add",
        "%window-close",
        "%sessions-changed",
        "%session-changed",
        "%session-window-changed",
        "%unlinked-window-add",
        "%unlinked-window-close",
        "%pane-mode-changed",
    }


def emit_structural_state(session_name, history_lines):
    snapshot = capture_snapshot(session_name, history_lines)
    if snapshot:
        emit({"type": "state", "snapshot": snapshot})


def handle_control_line(session_name, line, history_lines):
    if line.startswith("%begin ") or line.startswith("%end ") or line.startswith("%error "):
        return False
    if line == "%exit":
        raise EOFError("tmux control client exited")
    if line.startswith("%output "):
        _, pane_id, payload = line.split(" ", 2)
        decoded = unescape_tmux_output(payload)
        if decoded:
            emit({"type": "output", "paneId": pane_id, "data": decoded})
        return False
    if line.startswith("%extended-output "):
        parts = line.split(" ", 4)
        pane_id = parts[1] if len(parts) > 1 else ""
        marker = parts[3] if len(parts) > 3 else ""
        payload = parts[4] if len(parts) > 4 else marker
        if marker == ":" and len(parts) > 4:
            payload = parts[4]
        decoded = unescape_tmux_output(payload)
        if decoded:
            emit({"type": "output", "paneId": pane_id, "data": decoded})
        return False
    if is_structural_event(line):
        return True
    return False


def stdin_forwarder(master_fd, stop_event):
    while not stop_event.is_set():
        line = sys.stdin.readline()
        if not line:
            stop_event.set()
            break
        os.write(master_fd, line.encode("utf-8"))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--session-name", required=True)
    parser.add_argument("--cols", type=int, default=160)
    parser.add_argument("--rows", type=int, default=40)
    parser.add_argument("--history-lines", type=int, default=10000)
    args = parser.parse_args()

    if not has_session(args.session_name):
        emit({"type": "error", "message": "stored tmux session no longer exists"})
        return 1

    master_fd, slave_fd = pty.openpty()
    env = dict(os.environ)
    env.setdefault("TERM", "xterm-256color")
    env.setdefault("COLORTERM", "truecolor")
    proc = subprocess.Popen(
        ["tmux", "-CC", "attach-session", "-t", args.session_name],
        stdin=slave_fd,
        stdout=slave_fd,
        stderr=slave_fd,
        close_fds=True,
        env=env,
    )
    os.close(slave_fd)

    stop_event = threading.Event()
    thread = threading.Thread(target=stdin_forwarder, args=(master_fd, stop_event), daemon=True)
    thread.start()

    os.write(master_fd, f"refresh-client -C {args.cols}x{args.rows}\n".encode("utf-8"))
    snapshot = capture_snapshot_with_size_wait(
        args.session_name,
        args.history_lines,
        args.cols,
        args.rows,
    )
    if snapshot:
        emit({"type": "state", "snapshot": snapshot})

    pending = ""
    pending_structural_emit_at = None
    try:
        while not stop_event.is_set():
            now = time.monotonic()
            if pending_structural_emit_at is not None and now >= pending_structural_emit_at:
                emit_structural_state(args.session_name, args.history_lines)
                pending_structural_emit_at = None
                continue

            timeout = 0.25
            if pending_structural_emit_at is not None:
                timeout = max(0.0, min(timeout, pending_structural_emit_at - now))

            ready, _, _ = select.select([master_fd], [], [], timeout)
            if master_fd not in ready:
                if pending_structural_emit_at is not None and time.monotonic() >= pending_structural_emit_at:
                    emit_structural_state(args.session_name, args.history_lines)
                    pending_structural_emit_at = None
                    continue
                if proc.poll() is not None:
                    break
                continue
            chunk = os.read(master_fd, 4096)
            if not chunk:
                break
            pending += chunk.decode("utf-8", errors="replace")
            lines, pending = split_control_messages(pending)
            for line in lines:
                try:
                    if handle_control_line(args.session_name, line, args.history_lines):
                        pending_structural_emit_at = time.monotonic() + STRUCTURAL_STATE_COALESCE_SEC
                except EOFError:
                    stop_event.set()
                    break
    except Exception as error:
        emit({"type": "error", "message": f"tmux proxy failed: {error}"})
    finally:
        stop_event.set()
        try:
            proc.terminate()
        except Exception:
            pass
        try:
            os.close(master_fd)
        except Exception:
            pass

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
