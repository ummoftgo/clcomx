export type ContextMenuItem =
  | {
      id: string;
      kind: "item";
      label: string;
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

