/**
 * AgentComposer 테스트(T5.4) — send/stop flow·Enter 전송·Shift+Enter 비전송·focus/shortcut 회귀(08 §6, FE §11).
 */

import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initializeI18n } from "../../../i18n";
import { TEST_IDS } from "../../../testids";
import AgentComposer from "./AgentComposer.svelte";

/** ②-C: mode/model/effort/approval 셀렉터는 turn 옵션 popover 뒤로 통합됐다. 셀렉터 접근 전 popover를 연다. */
async function openOptions(getByTestId: (id: string) => HTMLElement): Promise<void> {
  await fireEvent.click(getByTestId(TEST_IDS.agentComposerOptionsToggle));
}

function imageTransfer(file: File): DataTransfer {
  return {
    files: [file],
    items: [
      {
        kind: "file",
        type: file.type,
        getAsFile: () => file,
      },
    ],
  } as unknown as DataTransfer;
}

describe("AgentComposer", () => {
  beforeEach(() => {
    initializeI18n("en", "en-US");
  });

  it("sends text content via onSend on Enter", async () => {
    const onSend = vi.fn();
    const { getByTestId } = render(AgentComposer, {
      props: { status: "ready", providerLabel: "codex", onSend, onStop: vi.fn() },
    });
    const input = getByTestId(TEST_IDS.agentComposerInput) as HTMLTextAreaElement;
    await fireEvent.input(input, { target: { value: "hello" } });
    await fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith([{ type: "text", text: "hello" }]);
  });

  it("does not send on Shift+Enter (newline, no shortcut interception)", async () => {
    const onSend = vi.fn();
    const { getByTestId } = render(AgentComposer, {
      props: { status: "ready", providerLabel: "codex", onSend, onStop: vi.fn() },
    });
    const input = getByTestId(TEST_IDS.agentComposerInput) as HTMLTextAreaElement;
    await fireEvent.input(input, { target: { value: "line" } });
    await fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("keeps app tab shortcuts from firing while the composer textarea is focused", async () => {
    const onWindowKeydown = vi.fn();
    window.addEventListener("keydown", onWindowKeydown);
    try {
      const { getByTestId } = render(AgentComposer, {
        props: { status: "ready", providerLabel: "codex", onSend: vi.fn(), onStop: vi.fn() },
      });
      const input = getByTestId(TEST_IDS.agentComposerInput) as HTMLTextAreaElement;
      input.focus();

      await fireEvent.keyDown(input, { key: "t", ctrlKey: true });
      await fireEvent.keyDown(input, { key: "w", ctrlKey: true });

      expect(onWindowKeydown).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", onWindowKeydown);
    }
  });

  it("shows a stop button while running and calls onStop", async () => {
    const onStop = vi.fn();
    const { getByTestId } = render(AgentComposer, {
      props: { status: "running", providerLabel: "codex", onSend: vi.fn(), onStop },
    });
    await fireEvent.click(getByTestId(TEST_IDS.agentComposerSend));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("keeps the draft editable while running without sending on Enter", async () => {
    const onSend = vi.fn();
    const { getByTestId } = render(AgentComposer, {
      props: { status: "running", providerLabel: "codex", onSend, onStop: vi.fn() },
    });
    const input = getByTestId(TEST_IDS.agentComposerInput) as HTMLTextAreaElement;

    expect(input.disabled).toBe(false);

    await fireEvent.input(input, { target: { value: "queue later" } });
    await fireEvent.keyDown(input, { key: "Enter" });

    expect(onSend).not.toHaveBeenCalled();
    expect(input.value).toBe("queue later");
  });

  it("disables input while waiting for approval (requires_action)", () => {
    const { getByTestId } = render(AgentComposer, {
      props: {
        status: "requires_action",
        providerLabel: "codex",
        onSend: vi.fn(),
        onStop: vi.fn(),
      },
    });
    const input = getByTestId(TEST_IDS.agentComposerInput) as HTMLTextAreaElement;
    expect(input.disabled).toBe(true);
  });

  it("shows a stop button while waiting for approval (requires_action)", async () => {
    const onStop = vi.fn();
    const { getByTestId } = render(AgentComposer, {
      props: {
        status: "requires_action",
        providerLabel: "codex",
        onSend: vi.fn(),
        onStop,
      },
    });
    await fireEvent.click(getByTestId(TEST_IDS.agentComposerSend));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("mode selector: onModeChange + availableModes가 있으면 셀렉터를 노출하고 변경을 콜백한다", async () => {
    const onModeChange = vi.fn();
    const { getByTestId } = render(AgentComposer, {
      props: {
        status: "ready",
        providerLabel: "claude",
        onSend: vi.fn(),
        onStop: vi.fn(),
        availableModes: [
          { id: "default", name: "Default" },
          { id: "plan", name: "Plan" },
          { id: "acceptEdits", name: "Accept Edits" },
        ],
        currentModeId: "default",
        onModeChange,
      },
    });

    await openOptions(getByTestId);
    const select = getByTestId(TEST_IDS.agentComposerModeSelect) as HTMLSelectElement;
    expect(select.value).toBe("default");
    await fireEvent.change(select, { target: { value: "plan" } });
    expect(onModeChange).toHaveBeenCalledWith("plan");
  });

  it("mode selector: 요청만 보내고 화면 값은 권위 값에 머문다(수락 전/거부 모두 desync 없음)", async () => {
    const onModeChange = vi.fn().mockRejectedValue(new Error("rejected"));
    const { getByTestId } = render(AgentComposer, {
      props: {
        status: "ready",
        providerLabel: "claude",
        onSend: vi.fn(),
        onStop: vi.fn(),
        availableModes: [
          { id: "default", name: "Default" },
          { id: "plan", name: "Plan" },
        ],
        currentModeId: "default",
        onModeChange,
      },
    });

    await openOptions(getByTestId);
    const select = getByTestId(TEST_IDS.agentComposerModeSelect) as HTMLSelectElement;
    await fireEvent.change(select, { target: { value: "plan" } });
    expect(onModeChange).toHaveBeenCalledWith("plan");
    // 선택 즉시 권위 값(default)으로 되돌아가고, 거부돼도 그대로 유지된다(비권위 모드 미표시).
    await waitFor(() => expect(select.value).toBe("default"));
  });

  it("mode selector: 권위 currentModeId가 갱신되면 셀렉터가 그 값으로 이동한다", async () => {
    const { getByTestId, rerender } = render(AgentComposer, {
      props: {
        status: "ready",
        providerLabel: "claude",
        onSend: vi.fn(),
        onStop: vi.fn(),
        availableModes: [
          { id: "default", name: "Default" },
          { id: "plan", name: "Plan" },
        ],
        currentModeId: "default",
        onModeChange: vi.fn().mockResolvedValue(undefined),
      },
    });
    await openOptions(getByTestId);
    const select = getByTestId(TEST_IDS.agentComposerModeSelect) as HTMLSelectElement;
    expect(select.value).toBe("default");

    // provider echo로 currentModeId가 갱신된 상황을 재현한다.
    await rerender({ currentModeId: "plan" });
    expect(select.value).toBe("plan");
  });

  it("mode selector: 비-idle/ready 상태에서는 비활성이다", async () => {
    const { getByTestId } = render(AgentComposer, {
      props: {
        status: "requires_action",
        providerLabel: "claude",
        onSend: vi.fn(),
        onStop: vi.fn(),
        availableModes: [
          { id: "default", name: "Default" },
          { id: "plan", name: "Plan" },
        ],
        currentModeId: "default",
        onModeChange: vi.fn(),
      },
    });
    await openOptions(getByTestId);
    expect((getByTestId(TEST_IDS.agentComposerModeSelect) as HTMLSelectElement).disabled).toBe(true);
  });

  it("mode selector: restoring 중에는 비활성이다", async () => {
    const { getByTestId } = render(AgentComposer, {
      props: {
        status: "ready",
        providerLabel: "claude",
        onSend: vi.fn(),
        onStop: vi.fn(),
        restoring: true,
        availableModes: [
          { id: "default", name: "Default" },
          { id: "plan", name: "Plan" },
        ],
        currentModeId: "default",
        onModeChange: vi.fn(),
      },
    });
    await openOptions(getByTestId);
    expect((getByTestId(TEST_IDS.agentComposerModeSelect) as HTMLSelectElement).disabled).toBe(true);
  });

  it("mode selector: 고위험 모드(bypassPermissions) 진입은 확인 후에만 요청한다", async () => {
    const onModeChange = vi.fn().mockResolvedValue(undefined);
    const { getByTestId, queryByTestId } = render(AgentComposer, {
      props: {
        status: "ready",
        providerLabel: "claude",
        onSend: vi.fn(),
        onStop: vi.fn(),
        availableModes: [
          { id: "default", name: "Default" },
          { id: "bypassPermissions", name: "Bypass" },
        ],
        currentModeId: "default",
        onModeChange,
      },
    });

    await openOptions(getByTestId);
    const select = getByTestId(TEST_IDS.agentComposerModeSelect) as HTMLSelectElement;
    await fireEvent.change(select, { target: { value: "bypassPermissions" } });
    // 즉시 요청하지 않고 확인 게이트를 띄운다.
    expect(onModeChange).not.toHaveBeenCalled();
    expect(getByTestId(TEST_IDS.agentComposerModeConfirm)).toBeTruthy();
    expect(select.value).toBe("default"); // 확인 전까지 셀렉터는 권위 값 유지.

    await fireEvent.click(getByTestId(TEST_IDS.agentComposerModeConfirmAccept));
    expect(onModeChange).toHaveBeenCalledWith("bypassPermissions");
    expect(queryByTestId(TEST_IDS.agentComposerModeConfirm)).toBeNull();
  });

  it("mode selector: 고위험 진입 확인을 취소하면 요청하지 않는다", async () => {
    const onModeChange = vi.fn().mockResolvedValue(undefined);
    const { getByTestId, queryByTestId } = render(AgentComposer, {
      props: {
        status: "ready",
        providerLabel: "claude",
        onSend: vi.fn(),
        onStop: vi.fn(),
        availableModes: [
          { id: "default", name: "Default" },
          { id: "bypassPermissions", name: "Bypass" },
        ],
        currentModeId: "default",
        onModeChange,
      },
    });

    await openOptions(getByTestId);
    await fireEvent.change(getByTestId(TEST_IDS.agentComposerModeSelect), {
      target: { value: "bypassPermissions" },
    });
    await fireEvent.click(getByTestId(TEST_IDS.agentComposerModeConfirmCancel));
    expect(onModeChange).not.toHaveBeenCalled();
    expect(queryByTestId(TEST_IDS.agentComposerModeConfirm)).toBeNull();
  });

  it("mode selector: 확인 배너가 뜬 뒤 비-ready 상태로 바뀌면 accept가 요청하지 않는다", async () => {
    const onModeChange = vi.fn().mockResolvedValue(undefined);
    const { getByTestId, queryByTestId, rerender } = render(AgentComposer, {
      props: {
        status: "ready",
        providerLabel: "claude",
        onSend: vi.fn(),
        onStop: vi.fn(),
        availableModes: [
          { id: "default", name: "Default" },
          { id: "bypassPermissions", name: "Bypass" },
        ],
        currentModeId: "default",
        onModeChange,
      },
    });

    await openOptions(getByTestId);
    await fireEvent.change(getByTestId(TEST_IDS.agentComposerModeSelect), {
      target: { value: "bypassPermissions" },
    });
    expect(getByTestId(TEST_IDS.agentComposerModeConfirm)).toBeTruthy();

    // 확인 대기 중 turn이 시작(running)되면 배너가 사라지고 요청되지 않는다(lockout 불변식).
    await rerender({
      status: "running",
      providerLabel: "claude",
      onSend: vi.fn(),
      onStop: vi.fn(),
      availableModes: [
        { id: "default", name: "Default" },
        { id: "bypassPermissions", name: "Bypass" },
      ],
      currentModeId: "default",
      onModeChange,
    });
    expect(queryByTestId(TEST_IDS.agentComposerModeConfirm)).toBeNull();
    expect(onModeChange).not.toHaveBeenCalled();
  });

  it("mode selector: 저위험 모드는 확인 없이 바로 요청한다", async () => {
    const onModeChange = vi.fn().mockResolvedValue(undefined);
    const { getByTestId, queryByTestId } = render(AgentComposer, {
      props: {
        status: "ready",
        providerLabel: "claude",
        onSend: vi.fn(),
        onStop: vi.fn(),
        availableModes: [
          { id: "default", name: "Default" },
          { id: "plan", name: "Plan" },
        ],
        currentModeId: "default",
        onModeChange,
      },
    });
    await openOptions(getByTestId);
    await fireEvent.change(getByTestId(TEST_IDS.agentComposerModeSelect), {
      target: { value: "plan" },
    });
    expect(onModeChange).toHaveBeenCalledWith("plan");
    expect(queryByTestId(TEST_IDS.agentComposerModeConfirm)).toBeNull();
  });

  it("model selector: availableModels가 있으면 모델/effort 셀렉터를 노출하고 변경을 콜백한다", async () => {
    const onModelChange = vi.fn();
    const onEffortChange = vi.fn();
    const { getByTestId } = render(AgentComposer, {
      props: {
        status: "ready",
        providerLabel: "codex",
        onSend: vi.fn(),
        onStop: vi.fn(),
        availableModels: [
          { id: "gpt-a", label: "GPT A", efforts: [{ id: "low" }, { id: "high" }], defaultEffort: "low" },
          { id: "gpt-b", label: "GPT B", efforts: [{ id: "medium" }], defaultEffort: "medium" },
        ],
        selectedModel: "gpt-a",
        selectedEffort: "low",
        modelEfforts: [{ id: "low" }, { id: "high" }],
        onModelChange,
        onEffortChange,
      },
    });

    await openOptions(getByTestId);
    const modelSelect = getByTestId(TEST_IDS.agentComposerModelSelect) as HTMLSelectElement;
    expect(modelSelect.value).toBe("gpt-a");
    await fireEvent.change(modelSelect, { target: { value: "gpt-b" } });
    expect(onModelChange).toHaveBeenCalledWith("gpt-b");

    const effortSelect = getByTestId(TEST_IDS.agentComposerEffortSelect) as HTMLSelectElement;
    expect(effortSelect.value).toBe("low");
    await fireEvent.change(effortSelect, { target: { value: "high" } });
    expect(onEffortChange).toHaveBeenCalledWith("high");
  });

  it("model selector: availableModels가 없으면(Claude 등) 모델/effort 셀렉터를 노출하지 않는다", () => {
    const { queryByTestId } = render(AgentComposer, {
      props: {
        status: "ready",
        providerLabel: "claude",
        onSend: vi.fn(),
        onStop: vi.fn(),
        onModelChange: vi.fn(),
        onEffortChange: vi.fn(),
      },
    });
    expect(queryByTestId(TEST_IDS.agentComposerModelSelect)).toBeNull();
    expect(queryByTestId(TEST_IDS.agentComposerEffortSelect)).toBeNull();
  });

  it("model selector: 선택 모델이 effort를 지원하지 않으면 effort 셀렉터를 감춘다", async () => {
    const { queryByTestId, getByTestId } = render(AgentComposer, {
      props: {
        status: "ready",
        providerLabel: "codex",
        onSend: vi.fn(),
        onStop: vi.fn(),
        availableModels: [{ id: "gpt-a", label: "GPT A", efforts: [] }],
        selectedModel: "gpt-a",
        modelEfforts: [],
        onModelChange: vi.fn(),
        onEffortChange: vi.fn(),
      },
    });
    await openOptions(getByTestId);
    expect(getByTestId(TEST_IDS.agentComposerModelSelect)).toBeTruthy();
    expect(queryByTestId(TEST_IDS.agentComposerEffortSelect)).toBeNull();
  });

  it("mode selector: availableModes가 없으면(미지원 provider) 셀렉터를 노출하지 않는다", () => {
    const { queryByTestId } = render(AgentComposer, {
      props: {
        status: "ready",
        providerLabel: "codex",
        onSend: vi.fn(),
        onStop: vi.fn(),
        modeLabel: "workspace-write",
        onModeChange: vi.fn(),
      },
    });
    expect(queryByTestId(TEST_IDS.agentComposerModeSelect)).toBeNull();
  });

  // ─────────────────────── ②-C: approval override + turn 옵션 popover ───────────────────────
  const APPROVAL_POLICIES = ["untrusted", "on-failure", "on-request", "never"] as const;

  function approvalProps(overrides: Record<string, unknown> = {}) {
    return {
      status: "ready" as const,
      providerLabel: "codex",
      onSend: vi.fn(),
      onStop: vi.fn(),
      availableApprovalPolicies: APPROVAL_POLICIES,
      selectedApprovalPolicy: "on-request",
      onApprovalPolicyChange: vi.fn(),
      ...overrides,
    };
  }

  it("approval selector: 저위험 정책은 확인 없이 바로 콜백한다", async () => {
    const onApprovalPolicyChange = vi.fn();
    const { getByTestId, queryByTestId } = render(AgentComposer, {
      props: approvalProps({ onApprovalPolicyChange }),
    });
    await openOptions(getByTestId);
    await fireEvent.change(getByTestId(TEST_IDS.agentComposerApprovalSelect), {
      target: { value: "on-failure" },
    });
    expect(onApprovalPolicyChange).toHaveBeenCalledWith("on-failure");
    expect(queryByTestId(TEST_IDS.agentComposerApprovalConfirm)).toBeNull();
  });

  it("approval selector: never(고위험)는 확인 후에만 콜백하고 popover를 닫는다", async () => {
    const onApprovalPolicyChange = vi.fn();
    const { getByTestId, queryByTestId } = render(AgentComposer, {
      props: approvalProps({ onApprovalPolicyChange }),
    });
    await openOptions(getByTestId);
    const select = getByTestId(TEST_IDS.agentComposerApprovalSelect) as HTMLSelectElement;
    await fireEvent.change(select, { target: { value: "never" } });
    // 즉시 콜백하지 않고 확인 배너를 띄우며 popover를 닫는다(숨은 pending 방지).
    expect(onApprovalPolicyChange).not.toHaveBeenCalled();
    expect(getByTestId(TEST_IDS.agentComposerApprovalConfirm)).toBeTruthy();
    expect(queryByTestId(TEST_IDS.agentComposerOptionsPopover)).toBeNull();

    await fireEvent.click(getByTestId(TEST_IDS.agentComposerApprovalConfirmAccept));
    expect(onApprovalPolicyChange).toHaveBeenCalledWith("never");
    expect(queryByTestId(TEST_IDS.agentComposerApprovalConfirm)).toBeNull();
  });

  it("approval selector: never 확인을 취소하면 콜백하지 않는다", async () => {
    const onApprovalPolicyChange = vi.fn();
    const { getByTestId, queryByTestId } = render(AgentComposer, {
      props: approvalProps({ onApprovalPolicyChange }),
    });
    await openOptions(getByTestId);
    await fireEvent.change(getByTestId(TEST_IDS.agentComposerApprovalSelect), {
      target: { value: "never" },
    });
    await fireEvent.click(getByTestId(TEST_IDS.agentComposerApprovalConfirmCancel));
    expect(onApprovalPolicyChange).not.toHaveBeenCalled();
    expect(queryByTestId(TEST_IDS.agentComposerApprovalConfirm)).toBeNull();
  });

  it("approval selector: never 확인 대기 중 비-ready 상태가 되면 accept가 콜백하지 않는다", async () => {
    const onApprovalPolicyChange = vi.fn();
    const { getByTestId, queryByTestId, rerender } = render(AgentComposer, {
      props: approvalProps({ onApprovalPolicyChange }),
    });
    await openOptions(getByTestId);
    await fireEvent.change(getByTestId(TEST_IDS.agentComposerApprovalSelect), {
      target: { value: "never" },
    });
    expect(getByTestId(TEST_IDS.agentComposerApprovalConfirm)).toBeTruthy();
    // turn 시작(running)되면 배너가 사라지고 요청되지 않는다(lockout 불변식, mode와 동일).
    await rerender(approvalProps({ onApprovalPolicyChange, status: "running" }));
    expect(queryByTestId(TEST_IDS.agentComposerApprovalConfirm)).toBeNull();
    expect(onApprovalPolicyChange).not.toHaveBeenCalled();
  });

  it("approval selector: 실제 정책 미상이면 placeholder를 두고 값을 활성처럼 보이지 않는다", async () => {
    const { getByTestId } = render(AgentComposer, {
      props: approvalProps({ selectedApprovalPolicy: undefined }),
    });
    await openOptions(getByTestId);
    expect((getByTestId(TEST_IDS.agentComposerApprovalSelect) as HTMLSelectElement).value).toBe("");
  });

  it("options toggle: 실효 정책이 고위험(never)이면 토글에 고위험 표시가 붙는다", () => {
    const { getByTestId } = render(AgentComposer, {
      props: approvalProps({ selectedApprovalPolicy: "never", approvalHighRisk: true }),
    });
    const toggle = getByTestId(TEST_IDS.agentComposerOptionsToggle);
    expect(toggle.textContent).toContain("High Risk");
  });

  it("approval selector: provider 기본값(sentinel)은 결과 미상이라 확인 게이트 후에만 콜백한다", async () => {
    const onApprovalPolicyChange = vi.fn();
    const { getByTestId, queryByTestId } = render(AgentComposer, {
      props: approvalProps({ onApprovalPolicyChange }),
    });
    await openOptions(getByTestId);
    await fireEvent.change(getByTestId(TEST_IDS.agentComposerApprovalSelect), {
      target: { value: "__provider_default__" },
    });
    // provider default는 never로 풀릴 수 있어 never와 동일하게 확인 게이트를 거친다.
    expect(onApprovalPolicyChange).not.toHaveBeenCalled();
    expect(getByTestId(TEST_IDS.agentComposerApprovalConfirm)).toBeTruthy();
    await fireEvent.click(getByTestId(TEST_IDS.agentComposerApprovalConfirmAccept));
    expect(onApprovalPolicyChange).toHaveBeenCalledWith("__provider_default__");
    expect(queryByTestId(TEST_IDS.agentComposerApprovalConfirm)).toBeNull();
  });

  it("approval selector: never 대기 중 안전 scalar를 고르면 stale 확인이 never를 덮어쓰지 못한다", async () => {
    const onApprovalPolicyChange = vi.fn();
    const { getByTestId, queryByTestId } = render(AgentComposer, {
      props: approvalProps({ onApprovalPolicyChange }),
    });
    await openOptions(getByTestId);
    // never 선택 → 확인 배너(미확정), popover 닫힘.
    await fireEvent.change(getByTestId(TEST_IDS.agentComposerApprovalSelect), { target: { value: "never" } });
    expect(getByTestId(TEST_IDS.agentComposerApprovalConfirm)).toBeTruthy();
    // popover 다시 열어 안전 scalar 선택 → 즉시 적용 + 미확정 배너 소멸.
    await openOptions(getByTestId);
    await fireEvent.change(getByTestId(TEST_IDS.agentComposerApprovalSelect), { target: { value: "on-failure" } });
    expect(onApprovalPolicyChange).toHaveBeenCalledWith("on-failure");
    expect(queryByTestId(TEST_IDS.agentComposerApprovalConfirm)).toBeNull();
    // stale never는 남아 있지 않으므로 never로 덮어써지지 않는다.
    expect(onApprovalPolicyChange).not.toHaveBeenCalledWith("never");
  });

  it("mode selector: 고위험 대기 중 저위험 모드를 고르면 stale 확인이 고위험을 덮어쓰지 못한다", async () => {
    const onModeChange = vi.fn().mockResolvedValue(undefined);
    const { getByTestId, queryByTestId } = render(AgentComposer, {
      props: {
        status: "ready",
        providerLabel: "claude",
        onSend: vi.fn(),
        onStop: vi.fn(),
        availableModes: [
          { id: "default", name: "Default" },
          { id: "plan", name: "Plan" },
          { id: "bypassPermissions", name: "Bypass" },
        ],
        currentModeId: "default",
        onModeChange,
      },
    });
    await openOptions(getByTestId);
    await fireEvent.change(getByTestId(TEST_IDS.agentComposerModeSelect), { target: { value: "bypassPermissions" } });
    expect(getByTestId(TEST_IDS.agentComposerModeConfirm)).toBeTruthy();
    await openOptions(getByTestId);
    await fireEvent.change(getByTestId(TEST_IDS.agentComposerModeSelect), { target: { value: "plan" } });
    expect(onModeChange).toHaveBeenCalledWith("plan");
    expect(queryByTestId(TEST_IDS.agentComposerModeConfirm)).toBeNull();
    expect(onModeChange).not.toHaveBeenCalledWith("bypassPermissions");
  });

  it("options popover: 토글로 열고 Escape로 닫는다", async () => {
    const { getByTestId, queryByTestId } = render(AgentComposer, {
      props: approvalProps(),
    });
    expect(queryByTestId(TEST_IDS.agentComposerOptionsPopover)).toBeNull();
    await fireEvent.click(getByTestId(TEST_IDS.agentComposerOptionsToggle));
    const popover = getByTestId(TEST_IDS.agentComposerOptionsPopover);
    expect(popover).toBeTruthy();
    await fireEvent.keyDown(popover, { key: "Escape" });
    expect(queryByTestId(TEST_IDS.agentComposerOptionsPopover)).toBeNull();
  });

  it("opens the slash command palette and filters by query", async () => {
    const { getByTestId, queryByTestId, getAllByTestId } = render(AgentComposer, {
      props: {
        status: "ready",
        providerLabel: "claude",
        onSend: vi.fn(),
        onStop: vi.fn(),
        availableCommands: [{ name: "compact", description: "Compact" }, { name: "resume" }],
      },
    });
    const input = getByTestId(TEST_IDS.agentComposerInput) as HTMLTextAreaElement;
    await fireEvent.input(input, { target: { value: "/" } });
    expect(queryByTestId(TEST_IDS.agentComposerCommandPalette)).toBeTruthy();

    await fireEvent.input(input, { target: { value: "/co" } });
    const opts = getAllByTestId(TEST_IDS.agentComposerCommandOption);
    expect(opts).toHaveLength(1);
    expect(opts[0].textContent).toContain("/compact");
  });

  it("accepts a command with Enter without sending, inserting the command text", async () => {
    const onSend = vi.fn();
    const { getByTestId } = render(AgentComposer, {
      props: {
        status: "ready",
        providerLabel: "claude",
        onSend,
        onStop: vi.fn(),
        availableCommands: [{ name: "resume" }],
      },
    });
    const input = getByTestId(TEST_IDS.agentComposerInput) as HTMLTextAreaElement;
    await fireEvent.input(input, { target: { value: "/re" } });
    await fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    expect(input.value).toBe("/resume ");
  });

  it("normalizes provider command names with a leading slash before display and insertion", async () => {
    const onSend = vi.fn();
    const { getByTestId, getAllByTestId } = render(AgentComposer, {
      props: {
        status: "ready",
        providerLabel: "claude",
        onSend,
        onStop: vi.fn(),
        availableCommands: [{ name: "/review", description: "Review changes" }],
      },
    });
    const input = getByTestId(TEST_IDS.agentComposerInput) as HTMLTextAreaElement;

    await fireEvent.input(input, { target: { value: "/rev" } });
    const opts = getAllByTestId(TEST_IDS.agentComposerCommandOption);
    expect(opts).toHaveLength(1);
    expect(opts[0].textContent).toContain("/review");
    expect(opts[0].textContent).not.toContain("//review");

    await fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    expect(input.value).toBe("/review ");
  });

  it("deduplicates provider command names case-insensitively before adding local fallbacks", async () => {
    const { getByTestId, getAllByTestId } = render(AgentComposer, {
      props: {
        status: "ready",
        providerLabel: "claude",
        onSend: vi.fn(),
        onStop: vi.fn(),
        availableCommands: [{ name: "/Resume", description: "Provider resume" }],
      },
    });
    const input = getByTestId(TEST_IDS.agentComposerInput) as HTMLTextAreaElement;

    await fireEvent.input(input, { target: { value: "/" } });

    const opts = getAllByTestId(TEST_IDS.agentComposerCommandOption);
    const resumeOptions = opts.filter((o) => o.textContent?.toLowerCase().includes("/resume"));
    expect(resumeOptions).toHaveLength(1);
  });

  it("always offers a local /resume command when no provider commands exist", async () => {
    const { getByTestId, getAllByTestId } = render(AgentComposer, {
      props: { status: "ready", providerLabel: "codex", onSend: vi.fn(), onStop: vi.fn() },
    });
    const input = getByTestId(TEST_IDS.agentComposerInput) as HTMLTextAreaElement;
    await fireEvent.input(input, { target: { value: "/" } });
    const opts = getAllByTestId(TEST_IDS.agentComposerCommandOption);
    expect(opts.some((o) => o.textContent?.includes("/resume"))).toBe(true);
  });

  it("closes the slash command palette once command arguments start", async () => {
    const { getByTestId, queryByTestId } = render(AgentComposer, {
      props: {
        status: "ready",
        providerLabel: "claude",
        onSend: vi.fn(),
        onStop: vi.fn(),
        availableCommands: [{ name: "compact", inputHint: "<turns>" }],
      },
    });
    const input = getByTestId(TEST_IDS.agentComposerInput) as HTMLTextAreaElement;
    await fireEvent.input(input, { target: { value: "/co" } });
    expect(queryByTestId(TEST_IDS.agentComposerCommandPalette)).toBeTruthy();

    await fireEvent.input(input, { target: { value: "/compact now" } });
    expect(queryByTestId(TEST_IDS.agentComposerCommandPalette)).toBeNull();
  });

  it("does not open completion popups for @ without a resource source or for $", async () => {
    const { getByTestId, queryByTestId } = render(AgentComposer, {
      props: {
        status: "ready",
        providerLabel: "claude",
        onSend: vi.fn(),
        onStop: vi.fn(),
        availableCommands: [{ name: "compact" }],
      },
    });
    const input = getByTestId(TEST_IDS.agentComposerInput) as HTMLTextAreaElement;

    await fireEvent.input(input, { target: { value: "@" } });
    expect(queryByTestId(TEST_IDS.agentComposerCommandPalette)).toBeNull();
    expect(queryByTestId(TEST_IDS.agentComposerResourcePalette)).toBeNull();

    await fireEvent.input(input, { target: { value: "$" } });
    expect(queryByTestId(TEST_IDS.agentComposerCommandPalette)).toBeNull();
    expect(queryByTestId(TEST_IDS.agentComposerResourcePalette)).toBeNull();
  });

  it("opens a resource mention token from the resource action button", async () => {
    const resourceSearch = vi.fn(async () => []);
    const { getByTestId } = render(AgentComposer, {
      props: {
        status: "ready",
        providerLabel: "claude",
        onSend: vi.fn(),
        onStop: vi.fn(),
        resourceSearch,
      },
    });
    const input = getByTestId(TEST_IDS.agentComposerInput) as HTMLTextAreaElement;

    await fireEvent.input(input, { target: { value: "please inspect" } });
    await fireEvent.click(getByTestId(TEST_IDS.agentComposerResourceButton));

    expect(input.value).toBe("please inspect @");
    expect(document.activeElement).toBe(input);
    expect(resourceSearch).toHaveBeenCalledWith("");
  });

  it("hides the resource action button when no resource source is configured", () => {
    const { queryByTestId } = render(AgentComposer, {
      props: {
        status: "ready",
        providerLabel: "claude",
        onSend: vi.fn(),
        onStop: vi.fn(),
      },
    });

    expect(queryByTestId(TEST_IDS.agentComposerResourceButton)).toBeNull();
  });

  it("disables the resource action button while composer input is locked", async () => {
    const resourceSearch = vi.fn(async () => []);
    const { getByTestId } = render(AgentComposer, {
      props: {
        status: "requires_action",
        providerLabel: "claude",
        onSend: vi.fn(),
        onStop: vi.fn(),
        resourceSearch,
      },
    });
    const button = getByTestId(TEST_IDS.agentComposerResourceButton) as HTMLButtonElement;

    expect(button.disabled).toBe(true);
    await fireEvent.click(button);
    expect(resourceSearch).not.toHaveBeenCalled();
  });

  it("selects an @ file mention and sends it as resource content", async () => {
    const onSend = vi.fn();
    const resourceSearch = vi.fn(async (query: string) =>
      query === "app"
        ? [
            {
              label: "src/App.svelte",
              uri: "file:///home/tester/project/src/App.svelte",
              detail: "/home/tester/project/src/App.svelte",
            },
          ]
        : [],
    );
    const { getByTestId, findByTestId } = render(AgentComposer, {
      props: {
        status: "ready",
        providerLabel: "claude",
        onSend,
        onStop: vi.fn(),
        resourceSearch,
      },
    });
    const input = getByTestId(TEST_IDS.agentComposerInput) as HTMLTextAreaElement;

    await fireEvent.input(input, { target: { value: "@app" } });
    expect(await findByTestId(TEST_IDS.agentComposerResourcePalette)).toBeTruthy();
    expect(getByTestId(TEST_IDS.agentComposerResourceOption).textContent).toContain("src/App.svelte");

    await fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    expect(input.value).toBe("@src/App.svelte ");

    await fireEvent.input(input, { target: { value: "@src/App.svelte please inspect" } });
    await fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith([
      { type: "text", text: "@src/App.svelte please inspect" },
      { type: "resource", uri: "file:///home/tester/project/src/App.svelte" },
    ]);
  });

  it("selects a Codex skill mention and preserves skill metadata in resource content", async () => {
    const onSend = vi.fn();
    const resourceSearch = vi.fn(async (query: string) =>
      query === "review"
        ? [
            {
              label: "review",
              uri: "file:///home/tester/.codex/skills/review/SKILL.md",
              detail: "Review changes",
              mimeType: "application/vnd.codex.skill",
              text: "review",
              resourceKind: "skill" as const,
            },
          ]
        : [],
    );
    const { getByTestId, findByTestId } = render(AgentComposer, {
      props: {
        status: "ready",
        providerLabel: "codex",
        onSend,
        onStop: vi.fn(),
        resourceSearch,
      },
    });
    const input = getByTestId(TEST_IDS.agentComposerInput) as HTMLTextAreaElement;

    await fireEvent.input(input, { target: { value: "@review" } });
    expect(await findByTestId(TEST_IDS.agentComposerResourcePalette)).toBeTruthy();
    await fireEvent.keyDown(input, { key: "Enter" });
    await fireEvent.input(input, { target: { value: "@review please inspect" } });
    await fireEvent.keyDown(input, { key: "Enter" });

    expect(onSend).toHaveBeenCalledWith([
      { type: "text", text: "@review please inspect" },
      {
        type: "resource",
        uri: "file:///home/tester/.codex/skills/review/SKILL.md",
        mimeType: "application/vnd.codex.skill",
        text: "review",
        resourceKind: "skill",
      },
    ]);
  });

  it("selects an inline @ file mention without dropping the prompt prefix", async () => {
    const onSend = vi.fn();
    const resourceSearch = vi.fn(async (query: string) =>
      query === "app"
        ? [
            {
              label: "src/App.svelte",
              uri: "file:///home/tester/project/src/App.svelte",
            },
          ]
        : [],
    );
    const { getByTestId, findByTestId } = render(AgentComposer, {
      props: {
        status: "ready",
        providerLabel: "claude",
        onSend,
        onStop: vi.fn(),
        resourceSearch,
      },
    });
    const input = getByTestId(TEST_IDS.agentComposerInput) as HTMLTextAreaElement;

    await fireEvent.input(input, { target: { value: "please inspect @app" } });
    expect(await findByTestId(TEST_IDS.agentComposerResourcePalette)).toBeTruthy();

    await fireEvent.keyDown(input, { key: "Enter" });
    expect(input.value).toBe("please inspect @src/App.svelte ");

    await fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith([
      { type: "text", text: "please inspect @src/App.svelte" },
      { type: "resource", uri: "file:///home/tester/project/src/App.svelte" },
    ]);
  });

  it("does not attach a resource when the selected @ mention token is edited into another word", async () => {
    const onSend = vi.fn();
    const resourceSearch = vi.fn(async (query: string) =>
      query === "app"
        ? [
            {
              label: "src/App.svelte",
              uri: "file:///home/tester/project/src/App.svelte",
            },
          ]
        : [],
    );
    const { getByTestId, findByTestId } = render(AgentComposer, {
      props: {
        status: "ready",
        providerLabel: "claude",
        onSend,
        onStop: vi.fn(),
        resourceSearch,
      },
    });
    const input = getByTestId(TEST_IDS.agentComposerInput) as HTMLTextAreaElement;

    await fireEvent.input(input, { target: { value: "@app" } });
    expect(await findByTestId(TEST_IDS.agentComposerResourcePalette)).toBeTruthy();
    await fireEvent.keyDown(input, { key: "Enter" });

    await fireEvent.input(input, { target: { value: "@src/App.sveltex please inspect" } });
    await fireEvent.keyDown(input, { key: "Enter" });

    expect(onSend).toHaveBeenCalledWith([
      { type: "text", text: "@src/App.sveltex please inspect" },
    ]);
  });

  it("shows image attach controls only when provider image capability is enabled", () => {
    const enabled = render(AgentComposer, {
      props: {
        status: "ready",
        providerLabel: "claude",
        onSend: vi.fn(),
        onStop: vi.fn(),
        capabilities: { image: true, embeddedContext: true, audio: false },
      },
    });
    expect(enabled.queryByTestId(TEST_IDS.agentComposerImageButton)).toBeTruthy();
    expect(enabled.queryByTestId(TEST_IDS.agentComposerImageInput)).toBeTruthy();
    enabled.unmount();

    const disabled = render(AgentComposer, {
      props: {
        status: "ready",
        providerLabel: "codex",
        onSend: vi.fn(),
        onStop: vi.fn(),
        capabilities: { image: false, embeddedContext: false, audio: false },
      },
    });
    expect(disabled.queryByTestId(TEST_IDS.agentComposerImageButton)).toBeNull();
    expect(disabled.queryByTestId(TEST_IDS.agentComposerImageInput)).toBeNull();
  });

  it("sends selected image files as image content and allows image-only prompts", async () => {
    const onSend = vi.fn();
    const { getByTestId, findByTestId } = render(AgentComposer, {
      props: {
        status: "ready",
        providerLabel: "claude",
        onSend,
        onStop: vi.fn(),
        capabilities: { image: true, embeddedContext: true, audio: false },
      },
    });

    const fileInput = getByTestId(TEST_IDS.agentComposerImageInput) as HTMLInputElement;
    const image = new File(["abc"], "diagram.png", { type: "image/png" });
    await fireEvent.change(fileInput, { target: { files: [image] } });

    expect((await findByTestId(TEST_IDS.agentComposerImageAttachment)).textContent).toContain("diagram.png");
    await fireEvent.click(getByTestId(TEST_IDS.agentComposerSend));

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend).toHaveBeenCalledWith([
      { type: "image", uri: "data:image/png;base64,YWJj", mimeType: "image/png" },
    ]);
  });

  it("inserts image reference tokens into a non-empty draft and sends them with image content", async () => {
    const onSend = vi.fn();
    const { getByTestId, findByTestId } = render(AgentComposer, {
      props: {
        status: "ready",
        providerLabel: "claude",
        onSend,
        onStop: vi.fn(),
        capabilities: { image: true, embeddedContext: true, audio: false },
      },
    });
    const input = getByTestId(TEST_IDS.agentComposerInput) as HTMLTextAreaElement;
    const fileInput = getByTestId(TEST_IDS.agentComposerImageInput) as HTMLInputElement;

    await fireEvent.input(input, { target: { value: "Compare this" } });
    const image = new File(["abc"], "diagram.png", { type: "image/png" });
    await fireEvent.change(fileInput, { target: { files: [image] } });

    const attachment = await findByTestId(TEST_IDS.agentComposerImageAttachment);
    expect(input.value).toBe("Compare this [Image #1]");
    expect(attachment.textContent).toContain("[Image #1]");
    await fireEvent.keyDown(input, { key: "Enter" });

    expect(onSend).toHaveBeenCalledWith([
      { type: "text", text: "Compare this [Image #1]" },
      { type: "image", uri: "data:image/png;base64,YWJj", mimeType: "image/png" },
    ]);
  });

  it("removes the image reference token when the matching attachment is removed", async () => {
    const { getByTestId, findByTestId } = render(AgentComposer, {
      props: {
        status: "ready",
        providerLabel: "claude",
        onSend: vi.fn(),
        onStop: vi.fn(),
        capabilities: { image: true, embeddedContext: true, audio: false },
      },
    });
    const input = getByTestId(TEST_IDS.agentComposerInput) as HTMLTextAreaElement;
    const fileInput = getByTestId(TEST_IDS.agentComposerImageInput) as HTMLInputElement;

    await fireEvent.input(input, { target: { value: "Compare this" } });
    const image = new File(["abc"], "diagram.png", { type: "image/png" });
    await fireEvent.change(fileInput, { target: { files: [image] } });
    const attachment = await findByTestId(TEST_IDS.agentComposerImageAttachment);
    await fireEvent.click(attachment.querySelector("button") as HTMLButtonElement);

    expect(input.value).toBe("Compare this");
  });

  it("renumbers remaining image references after removing an attachment", async () => {
    const { getByTestId, findAllByTestId } = render(AgentComposer, {
      props: {
        status: "ready",
        providerLabel: "claude",
        onSend: vi.fn(),
        onStop: vi.fn(),
        capabilities: { image: true, embeddedContext: true, audio: false },
      },
    });
    const input = getByTestId(TEST_IDS.agentComposerInput) as HTMLTextAreaElement;
    const fileInput = getByTestId(TEST_IDS.agentComposerImageInput) as HTMLInputElement;

    await fireEvent.input(input, { target: { value: "Compare" } });
    const first = new File(["one"], "one.png", { type: "image/png" });
    const second = new File(["two"], "two.png", { type: "image/png" });
    await fireEvent.change(fileInput, { target: { files: [first, second] } });
    let attachments = await findAllByTestId(TEST_IDS.agentComposerImageAttachment);
    expect(input.value).toBe("Compare [Image #1] [Image #2]");

    await fireEvent.click(attachments[0].querySelector("button") as HTMLButtonElement);

    attachments = await findAllByTestId(TEST_IDS.agentComposerImageAttachment);
    expect(input.value).toBe("Compare [Image #1]");
    expect(attachments).toHaveLength(1);
    expect(attachments[0].textContent).toContain("[Image #1]");
    expect(attachments[0].textContent).not.toContain("[Image #2]");
  });

  it("starts image reference numbering from one for the next prompt", async () => {
    const onSend = vi.fn();
    const { getByTestId, findByTestId } = render(AgentComposer, {
      props: {
        status: "ready",
        providerLabel: "claude",
        onSend,
        onStop: vi.fn(),
        capabilities: { image: true, embeddedContext: true, audio: false },
      },
    });
    const input = getByTestId(TEST_IDS.agentComposerInput) as HTMLTextAreaElement;
    const fileInput = getByTestId(TEST_IDS.agentComposerImageInput) as HTMLInputElement;

    await fireEvent.input(input, { target: { value: "First" } });
    await fireEvent.change(fileInput, {
      target: { files: [new File(["one"], "one.png", { type: "image/png" })] },
    });
    await findByTestId(TEST_IDS.agentComposerImageAttachment);
    await fireEvent.click(getByTestId(TEST_IDS.agentComposerSend));

    await fireEvent.input(input, { target: { value: "Second" } });
    await fireEvent.change(fileInput, {
      target: { files: [new File(["two"], "two.png", { type: "image/png" })] },
    });
    await findByTestId(TEST_IDS.agentComposerImageAttachment);

    expect(input.value).toBe("Second [Image #1]");
  });

  it("attaches pasted image files when image capability is enabled", async () => {
    const onSend = vi.fn();
    const { getByTestId, findByTestId } = render(AgentComposer, {
      props: {
        status: "ready",
        providerLabel: "claude",
        onSend,
        onStop: vi.fn(),
        capabilities: { image: true, embeddedContext: true, audio: false },
      },
    });
    const input = getByTestId(TEST_IDS.agentComposerInput) as HTMLTextAreaElement;
    const image = new File(["paste"], "pasted.png", { type: "image/png" });

    await fireEvent.paste(input, { clipboardData: imageTransfer(image) });

    expect((await findByTestId(TEST_IDS.agentComposerImageAttachment)).textContent).toContain("pasted.png");
    await fireEvent.click(getByTestId(TEST_IDS.agentComposerSend));

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend).toHaveBeenCalledWith([
      { type: "image", uri: "data:image/png;base64,cGFzdGU=", mimeType: "image/png" },
    ]);
  });

  it("inserts pasted image reference tokens at the textarea cursor", async () => {
    const { getByTestId, findByTestId } = render(AgentComposer, {
      props: {
        status: "ready",
        providerLabel: "claude",
        onSend: vi.fn(),
        onStop: vi.fn(),
        capabilities: { image: true, embeddedContext: true, audio: false },
      },
    });
    const input = getByTestId(TEST_IDS.agentComposerInput) as HTMLTextAreaElement;
    await fireEvent.input(input, { target: { value: "Compare please" } });
    input.setSelectionRange("Compare".length, "Compare".length);
    const image = new File(["paste"], "pasted.png", { type: "image/png" });

    await fireEvent.paste(input, { clipboardData: imageTransfer(image) });

    await findByTestId(TEST_IDS.agentComposerImageAttachment);
    expect(input.value).toBe("Compare [Image #1] please");
  });

  it("attaches dropped image files when image capability is enabled", async () => {
    const onSend = vi.fn();
    const { getByTestId, findByTestId } = render(AgentComposer, {
      props: {
        status: "ready",
        providerLabel: "claude",
        onSend,
        onStop: vi.fn(),
        capabilities: { image: true, embeddedContext: true, audio: false },
      },
    });
    const input = getByTestId(TEST_IDS.agentComposerInput) as HTMLTextAreaElement;
    const image = new File(["drop"], "dropped.png", { type: "image/png" });

    await fireEvent.drop(input, { dataTransfer: imageTransfer(image) });

    expect((await findByTestId(TEST_IDS.agentComposerImageAttachment)).textContent).toContain("dropped.png");
    await fireEvent.click(getByTestId(TEST_IDS.agentComposerSend));

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend).toHaveBeenCalledWith([
      { type: "image", uri: "data:image/png;base64,ZHJvcA==", mimeType: "image/png" },
    ]);
  });
});
