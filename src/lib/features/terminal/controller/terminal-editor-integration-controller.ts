import type { SessionEditorState } from "../../../types";
import {
  createEditorFacade,
  type EditorFacadeDependencies,
} from "../../editor/controller/editor-facade";

interface TerminalEditorIntegrationControllerDependencies
  extends Omit<EditorFacadeDependencies, "syncSessionState"> {
  onEditorSessionStateChange?: (sessionState: SessionEditorState) => void | Promise<void>;
  createEditorFacadeImpl?: (deps: EditorFacadeDependencies) => ReturnType<typeof createEditorFacade>;
}

export function createTerminalEditorIntegrationController(
  deps: TerminalEditorIntegrationControllerDependencies,
) {
  const {
    onEditorSessionStateChange,
    createEditorFacadeImpl = createEditorFacade,
    ...editorFacadeDeps
  } = deps;

  return createEditorFacadeImpl({
    ...editorFacadeDeps,
    syncSessionState: (_sessionId, sessionState) => {
      void onEditorSessionStateChange?.(sessionState);
    },
  });
}
