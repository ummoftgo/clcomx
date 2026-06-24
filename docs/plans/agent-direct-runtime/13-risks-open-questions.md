# Risks and Defaults

## 주요 위험

### Protocol drift

Codex app-server와 ACP/Claude adapter는 빠르게 변한다. generated type과 runtime package version을 고정하고, update 시 schema diff를 검토해야 한다.

### Experimental surface

Codex app-server는 `--experimental`이 필요할 수 있다. 사용자-facing 기능으로 켜기 전에 experimental 경고와 fallback path가 필요하다.

### Windows/WSL path

ACP는 absolute path를 요구한다. CLCOMX는 WSL path, Windows path, file URI를 명확히 구분해야 한다.

### Approval deadlock

provider가 permission response를 기다리는 동안 UI가 닫히거나 cancel되면 agent가 멈출 수 있다. pending request cleanup은 runtime 필수 기능이다.

### Terminal regression

terminal embed와 legacy PTY가 공존하면 focus, shortcut, resize, bottom-follow 회귀가 생길 수 있다. UI 작업 전후 기존 terminal E2E를 유지해야 한다.

### Branding and product confusion

Claude Agent SDK integration은 Claude Code 또는 Anthropic 공식 제품처럼 보이면 안 된다. provider 표시와 UI copy를 조심한다.

## Resolved defaults

- direct runtime은 첫 구현에서 실험 flag 뒤에 둔다.
- Codex와 Claude 모두 stdio 우선으로 구현한다.
- transcript full cache는 1차 범위에서 제외하고 provider replay와 metadata 저장에 집중한다.
- raw protocol log는 기본 비활성화하고 redacted debug mode만 둔다.
- Claude ACP adapter package는 npm dependency 방식으로 고정한다.
