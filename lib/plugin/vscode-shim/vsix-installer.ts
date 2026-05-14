/**
 * VS Code `.vsix` installer — full-extension extraction.
 *
 * `lib/appearance/vscode-theme/parse-vsix.ts:readVsix()` already implements
 * theme-only extraction (with a strict 10 MB cap, eager theme parsing, and
 * the precise manifest-path discovery rules). That code is reused as the
 * upstream theme parser; this module extends the surface to extract:
 *
 *   • Every file under `extension/` (main bundle, snippets, grammars, LSP
 *     server binaries, READMEs, …) into an in-memory Map keyed by the
 *     normalised relative path.
 *   • A SHA-256 digest of the source `.vsix` bytes for the
 *     `vscodeExtensionRuntime` ledger.
 *   • Detected LSP binary candidates that
 *     `lib/plugin/vscode-shim/lsp-binary-policy.ts` (Phase M3) will
 *     adjudicate against the trusted-publisher ledger.
 *
 * Themes are parsed inline with `importVscodeThemeJson` so the appearance
 * layer can pull them through the same code path the existing theme-import
 * dialog uses — no duplicate parser.
 *
 * Size cap is **200 MB** here (vs the 10 MB cap for theme-only imports) —
 * matches the practical Open VSX upper bound for full-extension `.vsix`
 * payloads (e.g. Cline ~50 MB, rust-analyzer ~30 MB).
 */

import JSZip from "jszip"
import { importVscodeThemeJson, type ParsedTheme } from "@/lib/appearance/vscode-theme/parse-json"
import { normalizeRelPath, uiThemeToVariant } from "@/lib/appearance/vscode-theme/parse-vsix"
import type { VsCodeLspBinaryCandidate, VsCodeManifest } from "@/types/plugin/plugin-vscode"

/** Hard cap on the source `.vsix` size: 200 MB. */
export const MAX_FULL_VSIX_BYTES = 200 * 1024 * 1024

/** Manifest entry path inside the `.vsix` ZIP. */
const MANIFEST_PATH = "extension/package.json"

/** Prefix every theme/extension file lives under. */
const EXTENSION_PREFIX = "extension/"

export interface VsixThemeReady {
  /** Display label from the VSCode manifest. */
  label: string
  /** `"vs"` / `"vs-dark"` / `"hc-black"` / `"hc-light"`. */
  uiTheme?: string
  /** Normalised forward-slash path inside `extension/`. */
  path: string
  /** Eagerly parsed CustomTheme (zip buffer released after extraction). */
  parsed: ParsedTheme
}

export interface VsixInstallResult {
  /** Parsed VS Code `package.json`. */
  pkgJson: VsCodeManifest
  /** Every non-themed file inside `extension/`, keyed by forward-slash relative path. */
  files: Map<string, Uint8Array>
  /** SHA-256 hex of the raw `.vsix` bytes. */
  sha256: string
  /** Themes parsed via the existing `importVscodeThemeJson` pipeline. */
  themes: VsixThemeReady[]
  /** Executable artefacts the host must adjudicate before allowing spawn. */
  lspBinaryCandidates: VsCodeLspBinaryCandidate[]
  /** Detected module format of the main bundle. `null` when no `main` declared. */
  bundleFormat: "cjs" | "esm" | "mixed" | null
}

/**
 * Extract a `.vsix` into the in-memory representation the cognia plugin
 * manager + VS Code shim need at install time.
 *
 * Throws on:
 *   • payload over `MAX_FULL_VSIX_BYTES`
 *   • not a ZIP archive
 *   • missing `extension/package.json`
 *   • invalid JSON in the manifest
 *   • missing `publisher` or `name` field
 *
 * Theme-parse failures are warned and skipped (preserves backward compat
 * with `parse-vsix.ts:readVsix` behaviour).
 */
export async function installVsix(input: ArrayBuffer | Uint8Array): Promise<VsixInstallResult> {
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input
  if (bytes.byteLength === 0) {
    throw new Error("VSIX is empty")
  }
  if (bytes.byteLength > MAX_FULL_VSIX_BYTES) {
    throw new Error(`VSIX exceeds size cap (${MAX_FULL_VSIX_BYTES} bytes, got ${bytes.byteLength})`)
  }

  const sha256 = await computeSha256(bytes)

  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(bytes)
  } catch (err) {
    throw new Error(`Could not unzip VSIX: ${(err as Error).message}`)
  }

  const manifestFile = zip.file(MANIFEST_PATH)
  if (!manifestFile) {
    throw new Error(`VSIX is missing ${MANIFEST_PATH}`)
  }

  const manifestText = await manifestFile.async("string")
  let pkgJson: VsCodeManifest
  try {
    pkgJson = JSON.parse(manifestText) as VsCodeManifest
  } catch (err) {
    throw new Error(`VSIX package.json is invalid JSON: ${(err as Error).message}`)
  }
  if (!pkgJson || typeof pkgJson !== "object") {
    throw new Error("VSIX package.json did not yield an object")
  }
  if (typeof pkgJson.name !== "string" || pkgJson.name.length === 0) {
    throw new Error("VSIX package.json is missing required `name` field")
  }
  if (typeof pkgJson.publisher !== "string" || pkgJson.publisher.length === 0) {
    throw new Error("VSIX package.json is missing required `publisher` field")
  }

  // Walk every entry under `extension/` once. The manifest itself is
  // skipped because callers already have `pkgJson`. Iterate via JSZip's
  // canonical `forEach` to collect entries, then drain via `.async()` — the
  // forEach callback is synchronous, so the actual reads happen below.
  const files = new Map<string, Uint8Array>()
  const targets: Array<{ entry: JSZip.JSZipObject; normalised: string }> = []
  zip.forEach((zipPath, entry) => {
    if (entry.dir) return
    if (!zipPath.startsWith(EXTENSION_PREFIX)) return
    if (zipPath === MANIFEST_PATH) return
    const relPath = zipPath.slice(EXTENSION_PREFIX.length)
    if (relPath.length === 0) return
    targets.push({ entry, normalised: normalizeRelPath(relPath) })
  })
  await Promise.all(
    targets.map(async ({ entry, normalised }) => {
      const u8 = await entry.async("uint8array")
      files.set(normalised, u8)
    })
  )

  // Parse themes eagerly — same code path as `parse-vsix.ts:readVsix`.
  const themes: VsixThemeReady[] = []
  const rawThemes = (pkgJson.contributes?.themes ?? []) as unknown
  const themesArr = Array.isArray(rawThemes) ? rawThemes : []
  for (const raw of themesArr) {
    if (!raw || typeof raw !== "object") continue
    const r = raw as { label?: unknown; uiTheme?: unknown; path?: unknown }
    if (typeof r.path !== "string" || r.path.length === 0) continue
    const path = normalizeRelPath(r.path)
    const buf = files.get(path)
    if (!buf) continue
    const label = typeof r.label === "string" && r.label.length > 0 ? r.label : path
    const uiTheme = typeof r.uiTheme === "string" ? r.uiTheme : undefined
    try {
      const text = new TextDecoder("utf-8").decode(buf)
      const forceVariant = uiThemeToVariant(uiTheme)
      const parsed = importVscodeThemeJson(text, {
        nameHint: label,
        ...(forceVariant ? { forceVariant } : {}),
      })
      themes.push({ label, uiTheme, path, parsed })
    } catch (err) {
      console.warn(`VSIX theme ${path} failed to parse: ${(err as Error).message}`)
    }
  }

  // Detect LSP binaries. Adjudication is the policy layer's job; here we
  // only enumerate candidates.
  const lspBinaryCandidates = await detectLspBinaries(files)

  // Determine module format of the main bundle.
  const bundleFormat = detectBundleFormat(pkgJson, files)

  return {
    pkgJson,
    files,
    sha256,
    themes,
    lspBinaryCandidates,
    bundleFormat,
  }
}

/**
 * SHA-256 of a Uint8Array using the Web Crypto API. Works in both browser
 * (renderer) and Node (test runner via jsdom + crypto).
 */
async function computeSha256(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (subtle) {
    // Materialise into a fresh ArrayBuffer so the SubtleCrypto signature
    // accepts the input regardless of whether the underlying buffer is
    // backed by SharedArrayBuffer (Node test env) or ArrayBuffer (browser).
    const copy = new Uint8Array(bytes.byteLength)
    copy.set(bytes)
    const digest = await subtle.digest("SHA-256", copy.buffer)
    return bufferToHex(new Uint8Array(digest))
  }
  // Node fallback (e.g. jest node env). Avoid a top-level import so the
  // browser bundle doesn't pull in `node:crypto`.
  const nodeCrypto = (await import("node:crypto")) as typeof import("node:crypto")
  const hash = nodeCrypto.createHash("sha256")
  hash.update(bytes)
  return hash.digest("hex")
}

function bufferToHex(buf: Uint8Array): string {
  let hex = ""
  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i]!
    hex += (byte < 16 ? "0" : "") + byte.toString(16)
  }
  return hex
}

const NATIVE_EXE_EXTS = new Set([".exe", ".dll", ".so", ".dylib"])
const NODE_NATIVE_EXTS = new Set([".node"])
const WASM_EXTS = new Set([".wasm"])
const SHELL_EXTS = new Set([".sh", ".bash", ".zsh", ".fish", ".ps1", ".cmd", ".bat"])

/**
 * Inspect every file in the extension payload and flag executable artefacts
 * the LSP binary policy must adjudicate. Each candidate carries enough
 * metadata (path, size, SHA-256, kind) for the policy gate to make a
 * decision without re-reading the file.
 */
async function detectLspBinaries(
  files: Map<string, Uint8Array>
): Promise<VsCodeLspBinaryCandidate[]> {
  const out: VsCodeLspBinaryCandidate[] = []
  for (const [path, bytes] of files) {
    const ext = extensionOf(path)
    let kind: VsCodeLspBinaryCandidate["kind"] | null = null
    if (NATIVE_EXE_EXTS.has(ext)) {
      kind = "native-exe"
    } else if (NODE_NATIVE_EXTS.has(ext)) {
      kind = "native-exe"
    } else if (WASM_EXTS.has(ext)) {
      kind = "wasm-component"
    } else if (SHELL_EXTS.has(ext)) {
      kind = "shell-script"
    } else if (looksLikeShebangScript(bytes)) {
      kind = "shell-script"
    } else if (looksLikeNodeBinary(bytes)) {
      kind = "node-binary"
    }
    if (!kind) continue
    out.push({
      path,
      size: bytes.byteLength,
      sha256: await computeSha256(bytes),
      kind,
    })
  }
  return out
}

function extensionOf(path: string): string {
  const dot = path.lastIndexOf(".")
  if (dot === -1) return ""
  return path.slice(dot).toLowerCase()
}

function looksLikeShebangScript(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x23 /* # */ && bytes[1] === 0x21 /* ! */
}

function looksLikeNodeBinary(bytes: Uint8Array): boolean {
  // Heuristic: `.js` files lacking a known extension but invoking
  // `process.argv` at the top often act as CLI entry points (LSP servers
  // distributed via npm). We only flag when the bundle is small enough
  // to inspect — large bundles are likely the extension's own `main`.
  if (bytes.byteLength > 4 * 1024 * 1024) return false
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, 4096))
  return head.includes("process.argv") && head.includes("LanguageServer")
}

/**
 * Decide whether the main bundle is CJS, ESM, or mixed. The sidecar's
 * extension-runner needs this to pick between `vm.Script` (CJS) and
 * `vm.Module` (ESM, requires `--experimental-vm-modules`).
 *
 * Returns `null` when the manifest declares no `main` (theme-only,
 * grammar-only extensions never reach the sidecar).
 */
function detectBundleFormat(
  pkgJson: VsCodeManifest,
  files: Map<string, Uint8Array>
): "cjs" | "esm" | "mixed" | null {
  const mainPath = pkgJson.main
  if (typeof mainPath !== "string" || mainPath.length === 0) return null
  const candidates: string[] = [
    normalizeRelPath(mainPath),
    normalizeRelPath(`${mainPath}.js`),
    normalizeRelPath(`${mainPath}.cjs`),
    normalizeRelPath(`${mainPath}.mjs`),
    normalizeRelPath(`${mainPath}/index.js`),
  ]
  let bundle: Uint8Array | undefined
  let resolvedPath: string | undefined
  for (const candidate of candidates) {
    bundle = files.get(candidate)
    if (bundle) {
      resolvedPath = candidate
      break
    }
  }
  if (!bundle || !resolvedPath) return null

  if (resolvedPath.endsWith(".mjs")) return "esm"
  if (resolvedPath.endsWith(".cjs")) return "cjs"

  // Inspect the package.json's `type` field for ESM hint.
  const declaredType = (pkgJson as { type?: unknown }).type
  if (declaredType === "module") return "esm"
  if (declaredType === "commonjs") return "cjs"

  // Fall back to syntax sniffing on the bundle head.
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bundle.slice(0, 8192))
  const hasEsm =
    /\bexport\s+(?:default|const|function|class|\{)/.test(head) || /\bimport\s/.test(head)
  const hasCjs =
    /\bmodule\.exports\b/.test(head) || /\brequire\(/.test(head) || /\bexports\./.test(head)
  if (hasEsm && hasCjs) return "mixed"
  if (hasEsm) return "esm"
  return "cjs"
}
