/**
 * Filename → file-type icon classification.
 *
 * Chat shows file paths in a lot of places — `@` reference chips, the composer's
 * file picker, message attachments, the workspace changes list, ⌘K results — and
 * every one of them used to render the same generic page glyph, so a `.tsx` and a
 * `.png` and a lockfile were indistinguishable at a glance.
 *
 * This module is the classification half only: filename in, a {@link FileTypeIconKind}
 * and a tone out. It carries no React so the fast `node` Jest project can cover it,
 * and so the same answer can drive a chip, a tree row or a list item.
 * `components/shared/file-type-icon.tsx` maps a kind onto the actual glyph — and
 * prefers a VS Code icon theme when the user has a plugin contributing one, which
 * is why this file deliberately does not hard-code icon components.
 *
 * The taxonomy follows Material Icon Theme's grouping rather than inventing one:
 * a language gets its own kind when its icon would read differently from generic
 * "code" (json, markdown, sql…), and everything else folds into the nearest group.
 * Tones are Tailwind text colours chosen to survive both themes.
 */

export type FileTypeIconKind =
  | "folder"
  | "code"
  | "javascript"
  | "typescript"
  | "react"
  | "vue"
  | "svelte"
  | "python"
  | "rust"
  | "go"
  | "java"
  | "ruby"
  | "php"
  | "shell"
  | "json"
  | "yaml"
  | "toml"
  | "xml"
  | "html"
  | "css"
  | "markdown"
  | "text"
  | "pdf"
  | "document"
  | "spreadsheet"
  | "presentation"
  | "image"
  | "video"
  | "audio"
  | "font"
  | "archive"
  | "database"
  | "lock"
  | "key"
  | "config"
  | "git"
  | "docker"
  | "package"
  | "binary"
  | "notebook"
  | "file"

export interface FileTypeIcon {
  kind: FileTypeIconKind
  /** Tailwind text colour for the glyph. Empty string ⇒ inherit (neutral). */
  tone: string
}

/**
 * Tone per kind. Muted-by-default is deliberate: a chip row full of saturated
 * glyphs reads as noise, so only kinds whose colour is part of how the ecosystem
 * identifies them get one, and every colour is picked to hold up on both the
 * light and dark surface.
 */
const TONES: Record<FileTypeIconKind, string> = {
  folder: "text-sky-500 dark:text-sky-400",
  code: "text-muted-foreground",
  javascript: "text-yellow-500 dark:text-yellow-400",
  typescript: "text-blue-500 dark:text-blue-400",
  react: "text-cyan-500 dark:text-cyan-400",
  vue: "text-emerald-500 dark:text-emerald-400",
  svelte: "text-orange-500 dark:text-orange-400",
  python: "text-blue-500 dark:text-blue-400",
  rust: "text-orange-600 dark:text-orange-400",
  go: "text-cyan-600 dark:text-cyan-400",
  java: "text-red-500 dark:text-red-400",
  ruby: "text-red-600 dark:text-red-400",
  php: "text-indigo-500 dark:text-indigo-400",
  shell: "text-emerald-600 dark:text-emerald-400",
  json: "text-amber-500 dark:text-amber-400",
  yaml: "text-rose-500 dark:text-rose-400",
  toml: "text-orange-500 dark:text-orange-400",
  xml: "text-orange-500 dark:text-orange-400",
  html: "text-orange-500 dark:text-orange-400",
  css: "text-sky-500 dark:text-sky-400",
  markdown: "text-slate-500 dark:text-slate-400",
  text: "text-muted-foreground",
  pdf: "text-red-500 dark:text-red-400",
  document: "text-blue-500 dark:text-blue-400",
  spreadsheet: "text-green-600 dark:text-green-400",
  presentation: "text-orange-500 dark:text-orange-400",
  image: "text-purple-500 dark:text-purple-400",
  video: "text-pink-500 dark:text-pink-400",
  audio: "text-violet-500 dark:text-violet-400",
  font: "text-muted-foreground",
  archive: "text-amber-600 dark:text-amber-500",
  database: "text-teal-500 dark:text-teal-400",
  lock: "text-muted-foreground",
  key: "text-amber-500 dark:text-amber-400",
  config: "text-muted-foreground",
  git: "text-orange-600 dark:text-orange-400",
  docker: "text-blue-500 dark:text-blue-400",
  package: "text-red-500 dark:text-red-400",
  binary: "text-muted-foreground",
  notebook: "text-orange-500 dark:text-orange-400",
  file: "text-muted-foreground",
}

/**
 * Exact filenames, matched before any extension. These are the files whose
 * identity is the whole name — `package.json` is not "a JSON file" to anyone
 * reading a diff, and `Dockerfile` has no extension to match on at all.
 * Lower-cased keys; lookup lower-cases the basename too.
 */
const BY_FILENAME: Record<string, FileTypeIconKind> = {
  "package.json": "package",
  "package-lock.json": "lock",
  "pnpm-lock.yaml": "lock",
  "yarn.lock": "lock",
  "bun.lockb": "lock",
  "cargo.lock": "lock",
  "poetry.lock": "lock",
  "composer.lock": "lock",
  "gemfile.lock": "lock",
  "pnpm-workspace.yaml": "package",
  "cargo.toml": "package",
  "pyproject.toml": "package",
  "go.mod": "package",
  "go.sum": "lock",
  gemfile: "package",
  "composer.json": "package",
  dockerfile: "docker",
  "docker-compose.yml": "docker",
  "docker-compose.yaml": "docker",
  "compose.yml": "docker",
  "compose.yaml": "docker",
  ".dockerignore": "docker",
  ".gitignore": "git",
  ".gitattributes": "git",
  ".gitmodules": "git",
  ".gitkeep": "git",
  ".env": "key",
  ".env.local": "key",
  ".env.example": "key",
  makefile: "config",
  "cmakelists.txt": "config",
  ".editorconfig": "config",
  ".npmrc": "config",
  ".nvmrc": "config",
  ".prettierrc": "config",
  ".eslintrc": "config",
  license: "text",
  "license.md": "text",
  readme: "markdown",
  "readme.md": "markdown",
  "changelog.md": "markdown",
  "claude.md": "markdown",
}

/**
 * Extension → kind. Longest dotted suffix wins (so `.d.ts` and `.test.tsx`
 * resolve before `.ts`/`.tsx`), matching how VS Code icon themes resolve.
 */
const BY_EXTENSION: Record<string, FileTypeIconKind> = {
  // JS / TS family
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "react",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  "d.ts": "typescript",
  tsx: "react",
  vue: "vue",
  svelte: "svelte",
  // Other languages
  py: "python",
  pyi: "python",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "java",
  kts: "java",
  scala: "java",
  rb: "ruby",
  php: "php",
  c: "code",
  h: "code",
  cpp: "code",
  cc: "code",
  hpp: "code",
  cs: "code",
  swift: "code",
  m: "code",
  mm: "code",
  dart: "code",
  ex: "code",
  exs: "code",
  hs: "code",
  clj: "code",
  cljs: "code",
  lua: "code",
  r: "code",
  pl: "code",
  sol: "code",
  proto: "code",
  graphql: "code",
  gql: "code",
  // Shell
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  ps1: "shell",
  bat: "shell",
  cmd: "shell",
  // Data / config
  json: "json",
  jsonc: "json",
  json5: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  xml: "xml",
  plist: "xml",
  ini: "config",
  conf: "config",
  properties: "config",
  env: "key",
  // Web
  html: "html",
  htm: "html",
  xhtml: "html",
  css: "css",
  scss: "css",
  sass: "css",
  less: "css",
  // Docs
  md: "markdown",
  mdx: "markdown",
  markdown: "markdown",
  rst: "text",
  txt: "text",
  log: "text",
  pdf: "pdf",
  doc: "document",
  docx: "document",
  docm: "document",
  odt: "document",
  rtf: "document",
  epub: "document",
  xls: "spreadsheet",
  xlsx: "spreadsheet",
  xlsm: "spreadsheet",
  ods: "spreadsheet",
  csv: "spreadsheet",
  tsv: "spreadsheet",
  ppt: "presentation",
  pptx: "presentation",
  pptm: "presentation",
  odp: "presentation",
  ipynb: "notebook",
  // Media
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  avif: "image",
  bmp: "image",
  ico: "image",
  svg: "image",
  heic: "image",
  mp4: "video",
  mov: "video",
  webm: "video",
  mkv: "video",
  avi: "video",
  mp3: "audio",
  wav: "audio",
  flac: "audio",
  ogg: "audio",
  m4a: "audio",
  aac: "audio",
  // Fonts
  woff: "font",
  woff2: "font",
  ttf: "font",
  otf: "font",
  eot: "font",
  // Archives
  zip: "archive",
  tar: "archive",
  gz: "archive",
  tgz: "archive",
  bz2: "archive",
  xz: "archive",
  rar: "archive",
  "7z": "archive",
  // Databases
  sql: "database",
  db: "database",
  sqlite: "database",
  sqlite3: "database",
  // Keys / certs
  pem: "key",
  key: "key",
  crt: "key",
  cer: "key",
  p12: "key",
  // Binaries
  wasm: "binary",
  so: "binary",
  dylib: "binary",
  dll: "binary",
  exe: "binary",
  bin: "binary",
  o: "binary",
  a: "binary",
  lock: "lock",
}

/** Basename of a path, tolerating both separators and a trailing one. */
export function basenameOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "")
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"))
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed
}

/**
 * Classify a path (or bare filename) for iconography.
 *
 * `isDir` is an argument rather than something inferred from the string because
 * every caller already knows — a directory named `styles.css` is a directory,
 * and guessing from the name is how a folder ends up wearing a stylesheet icon.
 */
export function resolveFileTypeIcon(path: string, isDir = false): FileTypeIcon {
  if (isDir) return { kind: "folder", tone: TONES.folder }
  const name = basenameOf(path).toLowerCase()
  if (!name) return { kind: "file", tone: TONES.file }

  const exact = BY_FILENAME[name]
  if (exact) return { kind: exact, tone: TONES[exact] }

  // Longest dotted suffix first: `app.d.ts` is TypeScript declarations before it
  // is a `.ts`, and `archive.tar.gz` is one archive rather than a `.gz`.
  // A leading dot is skipped so `.eslintrc.json` matches `json`, not `eslintrc.json`.
  const firstDot = name.indexOf(".", name.startsWith(".") ? 1 : 0)
  if (firstDot >= 0) {
    let suffix = name.slice(firstDot + 1)
    while (suffix.length > 0) {
      const kind = BY_EXTENSION[suffix]
      if (kind) return { kind, tone: TONES[kind] }
      const next = suffix.indexOf(".")
      if (next < 0) break
      suffix = suffix.slice(next + 1)
    }
  }
  return { kind: "file", tone: TONES.file }
}

/** Every kind this module can return — exported so the glyph map can be proven total. */
export const FILE_TYPE_ICON_KINDS = Object.keys(TONES) as FileTypeIconKind[]
