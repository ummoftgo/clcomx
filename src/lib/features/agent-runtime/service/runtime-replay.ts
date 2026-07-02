/**
 * Direct Agent Runtime — 격리 scrollback replay 조회(read-only history inspection, T5.6).
 *
 * 정본: `docs/plans/agent-direct-runtime/10-persistence-migration.md` §4.7, `08-ui-composition.md` §7.2.
 *
 * evicted-tombstone 구간을 사용자가 명시적으로 열 때만(자동 아님) 동작하는 read-only 조회 경로다.
 * provider replay(ACP `session/load`, Codex `thread/read(includeTurns)`)를 **별도 scratch 세션**으로
 * 1회 돌려 해당 구간을 조회하고, 결과를 **별도 scratch TranscriptModel**에 담아 read-only 인스펙션으로만
 * 보여준다. live store에 **병합하지 않으며**(복원/캐시 아님), 조회가 끝나면 scratch를 폐기한다.
 *
 * **경계 주의**(10 §4.7): 복원(restore)·full transcript cache·디스크 영속이 아니다. running 세션과
 * 비충돌이며 sendPrompt/respondApproval을 노출하지 않는다(read-only).
 *
 * **OQ-54 해소**: `codex-cli 0.142.2` app-server 실측에서 `thread/read{includeTurns:true}`는
 * 전체 thread snapshot을 반환한다. 따라서 provider port 기반 scratch replay는 기본 event 상한을 적용하고,
 * 상한 초과 시 read-only panel에 partial snapshot notice를 표시한다. no-op loader는 provider id/capability가
 * 없을 때만 쓰는 안전 fallback이다.
 */

import type { AgentEvent } from "../contracts/normalized";
import type { AgentRuntimeMetadata, SessionRuntimeKind } from "../contracts/metadata";
import type { AgentRuntimePort } from "../contracts/runtime-port";
import type { TranscriptModel } from "../contracts/transcript";
import {
  applyEvent,
  createEmptyTranscriptModel,
} from "../controller/agent-event-reducer";

/** OQ-54 full snapshot replay를 유한하게 막는 기본 event 상한. */
export const DEFAULT_REPLAY_EVENT_LIMIT = 1_000;

/** direct runtime kind를 provider id로 축약한다. */
function providerForRuntimeKind(kind: SessionRuntimeKind): "codex" | "claude" | null {
  if (kind === "direct-codex") return "codex";
  if (kind === "direct-claude") return "claude";
  return null;
}

/** provider별 replay에 필요한 원본 session/thread id가 metadata에 있는지 판정한다. */
function hasProviderReplayKey(
  metadata: AgentRuntimeMetadata | undefined,
  provider: "codex" | "claude" | null,
): boolean {
  if (!metadata || !provider || metadata.provider !== provider) return false;
  return provider === "codex"
    ? Boolean(metadata.providerThreadId)
    : Boolean(metadata.providerSessionId);
}

/** replay event 상한 옵션을 안전한 정수로 정규화한다. */
function normalizeReplayEventLimit(maxEvents: number | undefined): number {
  if (maxEvents === undefined || !Number.isFinite(maxEvents)) {
    return DEFAULT_REPLAY_EVENT_LIMIT;
  }
  return Math.max(0, Math.floor(maxEvents));
}

/** replay 조회 결과(격리 read-only). */
export interface ReplayResult {
  /** 조회로 채운 격리 scratch transcript(live와 분리). */
  transcript: TranscriptModel;
  /** 조회 후 scratch transcript에 반영한 event 수(0이면 표시할 이전 기록 없음). */
  eventCount: number;
  /** provider가 상한보다 많은 event를 반환해 read-only replay를 잘랐는지. */
  truncated: boolean;
}

/** replay 조회 reduce 옵션. */
export interface ReplayLoadOptions {
  /** scratch TranscriptModel에 반영할 최대 event 수. 기본값은 `DEFAULT_REPLAY_EVENT_LIMIT`. */
  maxEvents?: number;
}

/**
 * read-only replay loader. 격리 scratch 세션을 통해 evicted 구간 event를 조회한다.
 * provider port 기반 구현은 `resumeSession({replay:true})`를 경유하고, no-op/test 구현도 같은 표면을 쓴다.
 * 반환 event들은 reducer로 scratch TranscriptModel에 적용된다(live 미병합).
 */
export interface ReplayLoader {
  /** evicted 이전 기록 구간을 read-only로 조회 가능한지. false면 "사용 불가" notice(10 §4.7). */
  canLoad(): boolean;
  /** evicted 구간 event를 read-only로 조회한다(scratch 세션 1회). 조회 뒤 폐기는 호출부가 dispose로. */
  loadHistory(): Promise<AgentEvent[]>;
  /** scratch 세션 폐기(조회 완료/실패 뒤, 닫기·unmount 보조 cleanup). */
  dispose(): Promise<void>;
}

/** provider port 기반 replay loader 생성 옵션. */
export interface PortReplayLoaderOptions {
  /** provider/session capability가 replay load를 허용하는지. */
  canLoad: boolean;
  /** scratch session용 port 생성 함수. */
  createPort: (kind: SessionRuntimeKind) => AgentRuntimePort;
  /** 현재 direct runtime 종류. */
  runtimeKind: SessionRuntimeKind;
  /** live session handle. scratch handle의 prefix로만 사용한다. */
  sessionHandle: string;
  /** provider process 기동 distro. */
  distro: string;
  /** provider replay cwd. */
  workDir: string;
  /** provider replay id를 담은 현재 runtime metadata. */
  metadata: AgentRuntimeMetadata | undefined;
  /** scratch port가 수집할 최대 event 수. 기본값은 `DEFAULT_REPLAY_EVENT_LIMIT`. */
  maxEvents?: number;
  /** 테스트/격리용 scratch handle override. */
  scratchSessionHandle?: string;
}

/**
 * loader가 돌려준 event들을 격리 scratch TranscriptModel로 reduce한다(live store와 완전 분리).
 * reducer는 순수 함수이므로 동일 경로로 안전하게 read-only 모델을 만든다.
 */
export async function loadReplayTranscript(
  loader: ReplayLoader,
  options: ReplayLoadOptions = {},
): Promise<ReplayResult> {
  if (!loader.canLoad()) {
    return {
      transcript: createEmptyTranscriptModel(),
      eventCount: 0,
      truncated: false,
    };
  }
  const maxEvents = normalizeReplayEventLimit(options.maxEvents);
  const events = await loader.loadHistory();
  let model = createEmptyTranscriptModel();
  let eventCount = 0;
  for (const ev of events) {
    if (eventCount >= maxEvents) break;
    model = applyEvent(model, ev);
    eventCount += 1;
  }
  return {
    transcript: model,
    eventCount,
    truncated: events.length > eventCount,
  };
}

/**
 * provider port로 read-only scratch replay 세션을 연다.
 *
 * live store/controller를 거치지 않고 별도 sessionHandle로 `resumeSession(replay:true)`를 호출해
 * adapter가 emit한 event를 배열로만 수집한다. 호출부는 이 event를 scratch TranscriptModel에 reduce하므로
 * live transcript에는 병합되지 않는다(10 §4.7).
 */
export function createPortReplayLoader(options: PortReplayLoaderOptions): ReplayLoader {
  const provider = providerForRuntimeKind(options.runtimeKind);
  const scratchSessionHandle =
    options.scratchSessionHandle ?? `${options.sessionHandle}:replay`;
  let port: AgentRuntimePort | null = null;
  let unlisten: (() => void) | null = null;
  let loadPromise: Promise<AgentEvent[]> | null = null;
  let disposed = false;

  const canLoad = (): boolean =>
    options.canLoad === true &&
    options.metadata?.canLoad !== false &&
    hasProviderReplayKey(options.metadata, provider);
  const maxEvents = normalizeReplayEventLimit(options.maxEvents);

  return {
    canLoad,
    loadHistory: async () => {
      if (disposed) return [];
      if (!canLoad() || !provider) return [];
      if (loadPromise) return loadPromise;

      loadPromise = (async () => {
        const events: AgentEvent[] = [];
        port = options.createPort(options.runtimeKind);
        unlisten = port.subscribeEvents(scratchSessionHandle, (event) => {
          if (events.length >= maxEvents) return;
          events.push(event);
        });
        try {
          await port.resumeSession({
            sessionHandle: scratchSessionHandle,
            provider,
            distro: options.distro,
            workDir: options.workDir,
            providerSessionId: provider === "claude" ? options.metadata?.providerSessionId : undefined,
            providerThreadId: provider === "codex" ? options.metadata?.providerThreadId : undefined,
            replay: true,
          });
        } catch (err) {
          if (disposed) return [];
          throw err;
        }
        if (disposed) return [];
        return events;
      })();

      return loadPromise;
    },
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      try {
        if (port) await port.shutdown(scratchSessionHandle);
      } finally {
        try {
          unlisten?.();
        } catch {
          // 이미 해제됨 가능 — scratch 폐기 흐름에서는 무시한다.
        }
        unlisten = null;
        port = null;
        loadPromise = null;
      }
    },
  };
}

/**
 * provider replay를 열 수 없는 경계에서 쓰는 no-op loader.
 * `canLoad`는 주입된 능력 플래그를 그대로 따르고, 조회는 빈 결과를 돌려준다(표시할 이전 기록 없음).
 */
export function createDefaultReplayLoader(options: {
  canLoad: boolean;
}): ReplayLoader {
  return {
    canLoad: () => options.canLoad,
    loadHistory: async () => [],
    dispose: async () => {
      // scratch 세션 폐기 — 외부 자원이 없어 no-op.
    },
  };
}
