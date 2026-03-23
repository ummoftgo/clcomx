import { listAvailableEditors, type DetectedEditor } from "../editors";

type EditorDetectionState = {
  editors: DetectedEditor[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
};

const detection = $state<EditorDetectionState>({
  editors: [],
  loading: false,
  loaded: false,
  error: null,
});

let detectPromise: Promise<DetectedEditor[]> | null = null;

export function getEditorDetectionState(): EditorDetectionState {
  return detection;
}

export async function ensureEditorsDetected(force = false): Promise<DetectedEditor[]> {
  if (!force && detection.loaded) {
    return detection.editors;
  }

  if (!force && detectPromise) {
    return detectPromise;
  }

  detection.loading = true;
  detection.error = null;

  detectPromise = listAvailableEditors()
    .then((editors) => {
      detection.editors = editors;
      detection.loaded = true;
      detection.error = null;
      return editors;
    })
    .catch((error) => {
      detection.editors = [];
      detection.loaded = true;
      detection.error = error instanceof Error ? error.message : String(error);
      return [];
    })
    .finally(() => {
      detection.loading = false;
      detectPromise = null;
    });

  return detectPromise;
}

export function primeEditorsDetection(delayMs = 900) {
  if (detection.loaded || detection.loading || detectPromise) {
    return;
  }

  setTimeout(() => {
    if (detection.loaded || detection.loading || detectPromise) {
      return;
    }
    void ensureEditorsDetected();
  }, delayMs);
}
