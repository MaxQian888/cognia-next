/**
 * External-editor integration for the TUI: detect the user's preferred editor,
 * build the launch command for opening a file (optionally at a line/column),
 * spawn it, and report editor context for the `/editor` command.
 *
 * Mirrors the cross-platform spawn pattern in `cli/src/mcp/open-browser.ts`
 * (injectable `spawn`, resolve-on-`"spawn"` / false-on-`"error"`) and reuses
 * `markdown/hyperlink.supportsHyperlinks` for the OSC-8 capability readout. All
 * detection is pure over an injected `env` so it unit-tests without a terminal;
 * the only side effects (spawn, PATH probe) are injectable too.
 */
import { spawn as nodeSpawn, spawnSync } from "node:child_process"
import { pathToFileURL } from "node:url"
import path from "node:path"

import { type Spawn } from "../../mcp/open-browser"
import { supportsHyperlinks } from "../markdown/hyperlink"
import type { EditorConfig, EditorGotoFormat } from "../../config/schema"

/** The editor "family" — decides arg shape and whether a `vscode://` URI works. */
export type EditorFamily = "vscode" | "sublime" | "vim" | "jetbrains" | "generic"

/** A resolved editor: how to launch it and how it jumps to a line. */
export interface EditorDescriptor {
  id: string
  displayName: string
  /** The launcher command (first token only; embedded flags move to `args`). */
  command: string
  /** Extra flags inserted before the goto/file argument. */
  args: string[]
  family: EditorFamily
  supportsGoto: boolean
  /** Full argv (after `command`) to open `file`, optionally at `line`/`col`. */
  openArgs(file: string, line?: number, col?: number): string[]
  /** A `vscode://file/...` URI for OSC-8 links — only for the vscode family. */
  uri?(file: string, line?: number): string
}

/** What `/editor` reports about the current editor context. */
export interface EditorInfo {
  editor: EditorDescriptor
  source: "config" | "VISUAL" | "EDITOR" | "TERM_PROGRAM" | "path-probe" | "default"
  /** Whether this terminal was launched from inside an editor. */
  launchedFromEditor: boolean
  /** `TERM_PROGRAM`, when set. */
  terminalProgram?: string
  /** Whether the terminal renders OSC-8 hyperlinks (so paths are clickable). */
  hyperlinks: boolean
}

/** Base-command → display name + family for the editors we recognise. */
const EDITOR_TABLE: Record<string, { displayName: string; family: EditorFamily }> = {
  code: { displayName: "Visual Studio Code", family: "vscode" },
  "code-insiders": { displayName: "VS Code Insiders", family: "vscode" },
  codium: { displayName: "VSCodium", family: "vscode" },
  vscodium: { displayName: "VSCodium", family: "vscode" },
  cursor: { displayName: "Cursor", family: "vscode" },
  windsurf: { displayName: "Windsurf", family: "vscode" },
  subl: { displayName: "Sublime Text", family: "sublime" },
  sublime_text: { displayName: "Sublime Text", family: "sublime" },
  vim: { displayName: "Vim", family: "vim" },
  vi: { displayName: "Vi", family: "vim" },
  nvim: { displayName: "Neovim", family: "vim" },
  gvim: { displayName: "gVim", family: "vim" },
  idea: { displayName: "IntelliJ IDEA", family: "jetbrains" },
  webstorm: { displayName: "WebStorm", family: "jetbrains" },
  pycharm: { displayName: "PyCharm", family: "jetbrains" },
  goland: { displayName: "GoLand", family: "jetbrains" },
  rustrover: { displayName: "RustRover", family: "jetbrains" },
  clion: { displayName: "CLion", family: "jetbrains" },
  phpstorm: { displayName: "PhpStorm", family: "jetbrains" },
  rubymine: { displayName: "RubyMine", family: "jetbrains" },
}

/** Editors probed (in order) when nothing in env/config names one. */
export const EDITOR_PROBE_ORDER = [
  "code",
  "cursor",
  "code-insiders",
  "subl",
  "idea",
  "nvim",
  "vim",
] as const

/** Strip a directory + executable extension from a command token. */
function baseName(token: string): string {
  return path
    .basename(token)
    .replace(/\.(cmd|exe|bat|com)$/i, "")
    .toLowerCase()
}

/** Build a goto target (`file:line:col`) for the colon-style families. */
function colonGoto(file: string, line?: number, col?: number): string {
  if (line == null) return file
  return col == null ? `${file}:${line}` : `${file}:${line}:${col}`
}

/** Build a `vscode://file/...[:line[:col]]` URI from an absolute path. */
export function fileUri(file: string, line: number | undefined, family: EditorFamily): string {
  if (family !== "vscode") return pathToFileURL(file).href
  // Forward-slash the path, keep the Windows drive colon, ensure exactly one
  // leading slash after `file` (posix `/a` → `file//a`, win `C:/a` → `file/C:/a`).
  const fwd = file.replace(/\\/g, "/")
  const rooted = fwd.startsWith("/") ? fwd : `/${fwd}`
  return `vscode://file${rooted}${line != null ? `:${line}` : ""}`
}

/** The goto format implied by a family (used when no config override is given). */
function familyGoto(family: EditorFamily): EditorGotoFormat {
  if (family === "vscode") return "vscode"
  if (family === "sublime") return "sublime"
  if (family === "vim") return "vim"
  if (family === "jetbrains") return "jetbrains"
  return "none"
}

/**
 * Describe an editor from its command string (which may carry embedded flags,
 * e.g. `"code --wait"`). `opts.args` are prepended before the file argument and
 * `opts.gotoFormat` overrides the family-derived goto behaviour.
 */
export function describeEditor(
  command: string,
  opts: { args?: string[]; gotoFormat?: EditorGotoFormat } = {}
): EditorDescriptor {
  const tokens = command.trim().split(/\s+/).filter(Boolean)
  const launcher = tokens[0] ?? "vi"
  const embedded = tokens.slice(1)
  const base = baseName(launcher)
  const known = EDITOR_TABLE[base]
  const family: EditorFamily = known?.family ?? "generic"
  const goto = opts.gotoFormat ?? familyGoto(family)
  const args = [...embedded, ...(opts.args ?? [])]
  const supportsGoto = goto !== "none"

  const openArgs = (file: string, line?: number, col?: number): string[] => {
    if (line == null || goto === "none") return [...args, file]
    switch (goto) {
      case "vscode":
        return [...args, "-g", colonGoto(file, line, col)]
      case "sublime":
        return [...args, colonGoto(file, line, col)]
      case "vim":
        return [...args, `+${line}`, file]
      case "jetbrains":
        return [...args, "--line", String(line), file]
      default:
        return [...args, file]
    }
  }

  const descriptor: EditorDescriptor = {
    id: known ? base : "generic",
    displayName: known?.displayName ?? launcher,
    command: launcher,
    args,
    family,
    supportsGoto,
    openArgs,
  }
  if (family === "vscode") descriptor.uri = (file, line) => fileUri(file, line, "vscode")
  return descriptor
}

/** Default PATH probe: is `command` runnable? Uses `where`/`which` via a sync
 * spawn. Injectable so tests never touch the filesystem. */
export function commandExists(
  command: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  const finder = platform === "win32" ? "where" : "which"
  try {
    const res = spawnSync(finder, [command], { stdio: "ignore" })
    return res.status === 0
  } catch {
    return false
  }
}

/** Trim an env value to a meaningful string, or undefined when empty/blank. */
function nonBlank(v: string | undefined): string | undefined {
  const t = v?.trim()
  return t ? t : undefined
}

/**
 * Resolve the editor to use and where the choice came from. Order: config
 * override → `$VISUAL` → `$EDITOR` → `TERM_PROGRAM=vscode` → PATH probe → a
 * `code` fallback (which simply fails to launch with a notice if absent).
 */
export function detectEditor(
  env: Record<string, string | undefined>,
  opts: { config?: EditorConfig; probe?: (cmd: string) => boolean } = {}
): { editor: EditorDescriptor; source: EditorInfo["source"] } {
  const probe = opts.probe ?? ((c: string) => commandExists(c))
  const cfgCommand = nonBlank(opts.config?.command)
  if (cfgCommand) {
    return {
      editor: describeEditor(cfgCommand, {
        args: opts.config?.args,
        gotoFormat: opts.config?.gotoFormat,
      }),
      source: "config",
    }
  }
  const visual = nonBlank(env.VISUAL)
  if (visual) return { editor: describeEditor(visual), source: "VISUAL" }
  const editorEnv = nonBlank(env.EDITOR)
  if (editorEnv) return { editor: describeEditor(editorEnv), source: "EDITOR" }
  if (nonBlank(env.TERM_PROGRAM)?.toLowerCase() === "vscode") {
    return { editor: describeEditor("code"), source: "TERM_PROGRAM" }
  }
  for (const candidate of EDITOR_PROBE_ORDER) {
    if (probe(candidate)) return { editor: describeEditor(candidate), source: "path-probe" }
  }
  return { editor: describeEditor("code"), source: "default" }
}

/** Whether this terminal was spawned from inside an editor (VS Code / Cursor). */
export function launchedFromEditor(env: Record<string, string | undefined>): boolean {
  if (nonBlank(env.TERM_PROGRAM)?.toLowerCase() === "vscode") return true
  for (const key of Object.keys(env)) {
    if (key.startsWith("VSCODE_") && nonBlank(env[key])) return true
  }
  const askpass = `${env.GIT_ASKPASS ?? ""} ${env.VSCODE_GIT_ASKPASS_MAIN ?? ""}`.toLowerCase()
  return askpass.includes("vscode") || askpass.includes("cursor")
}

/** Compose the full editor context for the `/editor` command. */
export function editorInfo(
  env: Record<string, string | undefined>,
  opts: { config?: EditorConfig; probe?: (cmd: string) => boolean } = {}
): EditorInfo {
  const { editor, source } = detectEditor(env, opts)
  return {
    editor,
    source,
    launchedFromEditor: launchedFromEditor(env),
    terminalProgram: nonBlank(env.TERM_PROGRAM),
    hyperlinks: supportsHyperlinks(env),
  }
}

/**
 * Launch `editor` on `file` (optionally at `line`/`col`). Resolves true on a
 * clean spawn, false when the editor is missing or errors — the caller prints a
 * notice with the absolute path as the fallback. On Windows the launcher is a
 * `.cmd` shim, so it is run through `cmd /c` (mirrors `open-browser`'s `start`).
 */
export function openInEditor(
  file: string,
  opts: {
    line?: number
    col?: number
    editor: EditorDescriptor
    spawn?: Spawn
    platform?: NodeJS.Platform
    /** Keep the terminal suspended until the editing session closes. */
    wait?: boolean
  }
): Promise<boolean> {
  const platform = opts.platform ?? process.platform
  const spawn = opts.spawn ?? nodeSpawn
  const argv = opts.editor.openArgs(file, opts.line, opts.col)
  if (
    opts.wait &&
    ["vscode", "sublime", "jetbrains"].includes(opts.editor.family) &&
    !argv.includes("--wait")
  ) {
    argv.unshift("--wait")
  }
  const cmd = platform === "win32" ? "cmd" : opts.editor.command
  const args = platform === "win32" ? ["/c", opts.editor.command, ...argv] : argv
  return new Promise<boolean>((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: opts.wait ? "inherit" : "ignore", detached: false })
      child.on("error", () => resolve(false))
      if (opts.wait) child.on("exit", (code: number | null) => resolve(code === 0))
      else child.on("spawn", () => resolve(true))
    } catch {
      resolve(false)
    }
  })
}
