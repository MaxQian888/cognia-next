/**
 * Shared editor language ids + path mapping.
 *
 * Promoted from `components/skills/editor/language-from-path.ts` so every
 * editing surface (Skills, Canvas, Artifacts) and both editor stacks (Monaco
 * on desktop, the CodeMirror `LightCodeEditor` on mobile) share one closed
 * union. The values stay Monaco language ids — the CM loader
 * (`load-language-support.ts`) maps them to lazily-imported grammars.
 */

export type EditorLanguage =
  "markdown" | "typescript" | "python" | "shell" | "json" | "yaml" | "plaintext"

const TABLE: Record<string, EditorLanguage> = {
  md: "markdown",
  markdown: "markdown",
  js: "typescript",
  ts: "typescript",
  mjs: "typescript",
  cjs: "typescript",
  jsx: "typescript",
  tsx: "typescript",
  py: "python",
  pyi: "python",
  sh: "shell",
  bash: "shell",
  json: "json",
  jsonc: "json",
  yaml: "yaml",
  yml: "yaml",
}

export function languageFromPath(path: string): EditorLanguage {
  const dot = path.lastIndexOf(".")
  if (dot === -1) return "plaintext"
  const ext = path.slice(dot + 1).toLowerCase()
  return TABLE[ext] ?? "plaintext"
}

/**
 * Full-fidelity Monaco language id for a path — a superset of
 * `languageFromPath`, which deliberately collapses everything onto the closed
 * `EditorLanguage` union the CodeMirror grammar loader understands.
 *
 * The desktop Monaco workbench wants the real id: `rust`, `go`, `html` and
 * friends carry syntax highlighting, and the LSP bridge uses the same value
 * as the `languageId` in `textDocument/didOpen`, where "plaintext" would tell
 * a server the file is not theirs. Ids follow Monaco's `basic-languages`
 * contributions plus the LSP naming for the react variants.
 */
const MONACO_TABLE: Record<string, string> = {
  // The EditorLanguage union, kept identical so the two maps never disagree
  // about the languages they share.
  ...TABLE,
  // Everything below is Monaco-only; the CM side stays on the closed union.
  // Ids follow Monaco's basic-languages contributions — a format with no
  // contribution (groovy, erlang, make, cmake, prisma, …) stays plaintext
  // rather than claiming a grammar Monaco does not ship.
  // `jsonc` is NOT overridden: monaco-editor ≥0.56 registers only `json` —
  // the standalone `jsonc` id resolves to a language nobody owns and the
  // model renders as plaintext.
  es6: "javascript",
  jsx: "javascript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  mdx: "mdx",
  mdown: "markdown",
  mkd: "markdown",
  // Component SFCs have no Monaco grammar; `html` highlights the template
  // shell they share, which is closer than plaintext.
  vue: "html",
  svelte: "html",
  astro: "html",
  html: "html",
  htm: "html",
  xhtml: "html",
  css: "css",
  scss: "scss",
  less: "less",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  cs: "csharp",
  m: "objective-c",
  mm: "objective-c",
  rb: "ruby",
  php: "php",
  swift: "swift",
  lua: "lua",
  r: "r",
  jl: "julia",
  dart: "dart",
  scala: "scala",
  clj: "clojure",
  cljs: "clojure",
  ex: "elixir",
  exs: "elixir",
  fs: "fsharp",
  fsx: "fsharp",
  vb: "vb",
  pl: "perl",
  pm: "perl",
  coffee: "coffeescript",
  rst: "restructuredtext",
  liquid: "liquid",
  twig: "twig",
  sol: "solidity",
  wgsl: "wgsl",
  pyw: "python",
  sql: "sql",
  ps1: "powershell",
  psm1: "powershell",
  psd1: "powershell",
  bat: "bat",
  cmd: "bat",
  zsh: "shell",
  fish: "shell",
  ksh: "shell",
  dockerfile: "dockerfile",
  tf: "hcl",
  tfvars: "hcl",
  hcl: "hcl",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  env: "ini",
  toml: "ini",
  properties: "ini",
  xml: "xml",
  xsl: "xml",
  xslt: "xml",
  svg: "xml",
  wsdl: "xml",
  plist: "xml",
  graphql: "graphql",
  gql: "graphql",
  proto: "protobuf",
}

/** Monaco ids for extensionless names (or dotted names) that carry a language. */
const MONACO_NAME_TABLE: Record<string, string> = {
  ".gitignore": "ini",
  ".gitattributes": "ini",
  ".gitmodules": "ini",
  ".editorconfig": "ini",
  ".dockerignore": "ini",
  ".babelrc": "json",
  ".eslintrc": "json",
  ".prettierrc": "json",
  "tsconfig.json": "json",
  "jsconfig.json": "json",
  "go.mod": "go",
}

export function monacoLanguageFromPath(path: string): string {
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? ""
  // `.env`, `.env.local`, `.env.production`, … — the suffix is an environment,
  // not a language extension, so the name table must claim the family whole.
  if (name === ".env" || name.startsWith(".env.")) return "ini"
  // `Dockerfile`, `Dockerfile.dev`, `Containerfile` — the extension slot is a
  // target, not a language.
  if (name === "dockerfile" || name.startsWith("dockerfile.")) return "dockerfile"
  if (name === "containerfile" || name.startsWith("containerfile.")) return "dockerfile"
  const named = MONACO_NAME_TABLE[name]
  if (named) return named
  const dot = name.lastIndexOf(".")
  if (dot === -1) return "plaintext"
  return MONACO_TABLE[name.slice(dot + 1)] ?? "plaintext"
}

/**
 * Map a (possibly broader) Monaco language id — as stored on Canvas /
 * Artifact documents — onto the light editor's closed union. Unknown ids
 * degrade to plaintext (no highlighting, everything else still works).
 */
const MONACO_ID_MAP: Record<string, EditorLanguage> = {
  markdown: "markdown",
  typescript: "typescript",
  javascript: "typescript",
  typescriptreact: "typescript",
  javascriptreact: "typescript",
  python: "python",
  shell: "shell",
  shellscript: "shell",
  bash: "shell",
  json: "json",
  jsonc: "json",
  yaml: "yaml",
}

export function editorLanguageFromMonacoId(id: string | undefined | null): EditorLanguage {
  if (!id) return "plaintext"
  return MONACO_ID_MAP[id.toLowerCase()] ?? "plaintext"
}
