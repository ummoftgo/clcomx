export type ContextMenuIconId =
  | "external-link"
  | "copy"
  | "file"
  | "open-with";

export type ContextMenuItem =
  | {
      id: string;
      kind: "item";
      label: string;
      icon?: ContextMenuIconId;
      disabled?: boolean;
      danger?: boolean;
      value?: string;
    }
  | {
      id: string;
      kind: "header";
      label: string;
    }
  | {
      id: string;
      kind: "separator";
    };
