export interface InternalEditorTab {
  wslPath: string;
  content: string;
  languageId: string;
  dirty: boolean;
  line?: number | null;
  column?: number | null;
  loading?: boolean;
  saving?: boolean;
  error?: string | null;
}

export interface InternalEditorChangeEvent {
  wslPath: string;
  content: string;
}
