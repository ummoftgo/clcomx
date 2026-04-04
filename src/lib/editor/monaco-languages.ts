import * as monaco from "monaco-editor";

let configured = false;

interface MonacoTypeScriptLanguageDefaults {
  setCompilerOptions: (options: Record<string, unknown>) => void;
  setDiagnosticsOptions: (options: Record<string, unknown>) => void;
  setEagerModelSync: (value: boolean) => void;
}

interface MonacoTypeScriptApi {
  typescriptDefaults: MonacoTypeScriptLanguageDefaults;
  javascriptDefaults: MonacoTypeScriptLanguageDefaults;
  JsxEmit: { ReactJSX: number };
  ModuleKind: { ESNext: number };
  ModuleResolutionKind: { NodeJs: number };
  ScriptTarget: { ES2020: number };
}

export function ensureMonacoLanguageSupport() {
  if (configured) {
    return;
  }

  configureTypeScriptDefaults();
  registerSvelteLanguage();
  configured = true;
}

function configureTypeScriptDefaults() {
  const typeScriptApi = (monaco.languages as unknown as {
    typescript?: MonacoTypeScriptApi;
  }).typescript;
  if (!typeScriptApi) {
    return;
  }

  const compilerOptions = {
    allowNonTsExtensions: true,
    allowJs: true,
    checkJs: true,
    jsx: typeScriptApi.JsxEmit.ReactJSX,
    module: typeScriptApi.ModuleKind.ESNext,
    moduleResolution: typeScriptApi.ModuleResolutionKind.NodeJs,
    noEmit: true,
    target: typeScriptApi.ScriptTarget.ES2020,
  };

  typeScriptApi.typescriptDefaults.setCompilerOptions(compilerOptions);
  typeScriptApi.javascriptDefaults.setCompilerOptions(compilerOptions);
  typeScriptApi.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false,
  });
  typeScriptApi.javascriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false,
  });
  typeScriptApi.typescriptDefaults.setEagerModelSync(true);
  typeScriptApi.javascriptDefaults.setEagerModelSync(true);
}

function registerSvelteLanguage() {
  if (!monaco.languages.getLanguages().some((entry) => entry.id === "svelte")) {
    monaco.languages.register({
      id: "svelte",
      extensions: [".svelte"],
      aliases: ["Svelte", "svelte"],
      mimetypes: ["text/x-svelte"],
    });
  }

  monaco.languages.setLanguageConfiguration("svelte", {
    comments: {
      blockComment: ["<!--", "-->"],
    },
    brackets: [
      ["{", "}"],
      ["[", "]"],
      ["(", ")"],
      ["<", ">"],
    ],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
      { open: "`", close: "`" },
      { open: "<", close: ">" },
    ],
    surroundingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
      { open: "`", close: "`" },
      { open: "<", close: ">" },
    ],
  });

  monaco.languages.setMonarchTokensProvider("svelte", {
    defaultToken: "",
    tokenPostfix: ".svelte",
    keywords: [
      "break",
      "case",
      "catch",
      "class",
      "const",
      "continue",
      "debugger",
      "default",
      "delete",
      "do",
      "else",
      "export",
      "extends",
      "finally",
      "for",
      "function",
      "if",
      "import",
      "in",
      "instanceof",
      "let",
      "new",
      "return",
      "super",
      "switch",
      "this",
      "throw",
      "try",
      "typeof",
      "var",
      "void",
      "while",
      "with",
      "yield",
    ],
    tokenizer: {
      root: [
        [/<script\b[^>]*>/, { token: "tag", next: "@script" }],
        [/<style\b[^>]*>/, { token: "tag", next: "@style" }],
        [/{#(?:if|each|await|key)\b/, "keyword"],
        [/{:(?:else|then|catch)\b/, "keyword"],
        [/{\/(?:if|each|await|key)\b/, "keyword"],
        [/{@(?:html|debug|const|render)\b/, "keyword"],
        [/{/, { token: "delimiter.curly", next: "@interpolation" }],
        [/<!--/, "comment", "@comment"],
        [/<\/?[A-Za-z][^>]*?>/, "tag"],
        [/[^<{]+/, ""],
      ],
      script: [
        [/<\/script>/, { token: "tag", next: "@pop" }],
        [/[A-Za-z_$][\w$]*/, {
          cases: {
            "@keywords": "keyword",
            "@default": "identifier",
          },
        }],
        [/[{}()[\]]/, "@brackets"],
        [/`([^`\\]|\\.)*`/, "string"],
        [/"([^"\\]|\\.)*"/, "string"],
        [/'([^'\\]|\\.)*'/, "string"],
        [/\d+(\.\d+)?/, "number"],
        [/\/\/.*$/, "comment"],
        [/\/\*/, "comment", "@blockComment"],
      ],
      style: [
        [/<\/style>/, { token: "tag", next: "@pop" }],
        [/[^<]+/, ""],
      ],
      interpolation: [
        [/[A-Za-z_$][\w$]*/, {
          cases: {
            "@keywords": "keyword",
            "@default": "identifier",
          },
        }],
        [/[{}()[\]]/, "@brackets"],
        [/`([^`\\]|\\.)*`/, "string"],
        [/"([^"\\]|\\.)*"/, "string"],
        [/'([^'\\]|\\.)*'/, "string"],
        [/\d+(\.\d+)?/, "number"],
        [/\}/, { token: "delimiter.curly", next: "@pop" }],
      ],
      comment: [
        [/-->/, "comment", "@pop"],
        [/[^-]+/, "comment"],
        [/-/, "comment"],
      ],
      blockComment: [
        [/\*\//, "comment", "@pop"],
        [/[^*]+/, "comment"],
        [/\*/, "comment"],
      ],
    },
  });
}
