// Bridge between the Rust `slash_commands_scan` command and the frontend
// SlashCommand model. Custom markdown commands always end up as templates:
// their body text is the prompt, and we never run them as Action handlers.
//
// Save / delete go through `@tauri-apps/plugin-fs` directly rather than a
// dedicated Rust command. The surface is small (writeTextFile + remove +
// mkdir) and reusing the JS-side path keeps the Rust binary tight. Stage 3
// of the ClaudeCode 完整化 plan (Phase 7c).
//
// Two hosts, one module. The Rust scanner and `plugin-fs` are `target:
// "client"`: they exist in the desktop process and nowhere else, so on a
// paired browser or phone every call here used to throw and the settings UI
// hid authoring behind `isTauri()`. Project-scope commands now fall through to
// `./custom-workspace`, which reaches the same two directories over the
// companion-crossing `fs_*_workspace` commands. The user-global scope
// (`~/.claude/commands`) stays desktop-only, because it sits outside every
// workspace root and no pairing can reach it. That refusal is explicit
// (`GlobalScopeUnavailableError`) rather than an empty list, so the UI can say
// why instead of hiding the control.

import { invoke } from "@tauri-apps/api/core"
import type { SlashCommand, SlashScope } from "./builtin"
import { applyTemplate } from "./builtin"
import {
  DEFAULT_PROJECT_COMMAND_DIR,
  deleteWorkspaceCustomCommand,
  listWorkspaceCustomCommands,
  saveWorkspaceCustomCommand,
  type ProjectCommandDir,
} from "./custom-workspace"

interface RawCommand {
  name: string
  scope: string
  path: string
  description: string | null
  argumentHint: string | null
  allowedTools: string[] | null
  model: string | null
  paths: string[] | null
  disableModelInvocation: boolean | null
  userInvocable: boolean | null
  body: string
  /**
   * Absolute directory the file was discovered under. Added alongside the
   * `.cognia/commands` scan so the writer can put an edited command back where
   * it came from. Optional on the type because a host built before that change
   * does not send it.
   */
  originDir?: string | null
}

/**
 * The user-global scope needs the desktop process. Thrown rather than returned
 * so a caller cannot mistake "cannot reach it from here" for "there are none".
 */
export class GlobalScopeUnavailableError extends Error {
  constructor() {
    super("User-scope commands live in ~/.claude/commands and need the desktop app")
    this.name = "GlobalScopeUnavailableError"
  }
}

/** A custom command plus the directory it came from, when the host said. */
export interface CustomSlashCommand extends SlashCommand {
  /** Repo-relative for workspace reads, absolute for the desktop scanner. */
  originDir?: string
}

/** Which of the two project directories a path belongs to. */
export function projectCommandDirOf(originDir: string | null | undefined): ProjectCommandDir {
  return originDir?.replaceAll("\\", "/").includes("/.cognia/")
    ? ".cognia/commands"
    : DEFAULT_PROJECT_COMMAND_DIR
}

/**
 * Discover custom slash commands at `<cwd>/.cognia/commands/**\/*.md`,
 * `<cwd>/.claude/commands/**\/*.md` and `~/.claude/commands/**\/*.md`.
 *
 * The local Rust scanner is tried first because it is the only path that can
 * see the user-global directory, so when it answers it is authoritative. When
 * it is unreachable (a paired browser or phone, where the command is
 * `target: "client"` and simply does not exist) the project scope is read over
 * the workspace filesystem instead, which crosses the pairing. A broken
 * command file never breaks the picker.
 */
export async function loadCustomSlashCommands(
  cwd: string | null | undefined
): Promise<CustomSlashCommand[]> {
  try {
    const raw = await invoke<RawCommand[]>("slash_commands_scan", {
      cwd: cwd ?? null,
    })
    return raw.map(toSlashCommand)
  } catch (err) {
    if (typeof window !== "undefined") {
      // The Tauri-not-detected case is the most common reason this runs in a
      // plain Next.js dev server, so degrade gracefully without spamming the UI.
      console.debug("loadCustomSlashCommands local scan skipped:", err)
    }
  }
  // No cwd means no workspace root, so there is nothing project-scoped to read.
  if (!cwd) return []
  try {
    return await listWorkspaceCustomCommands(cwd)
  } catch (err) {
    if (typeof window !== "undefined") {
      console.debug("loadCustomSlashCommands workspace scan skipped:", err)
    }
    return []
  }
}

function toSlashCommand(raw: RawCommand): CustomSlashCommand {
  const scope: SlashScope =
    raw.scope === "user" ? "user" : raw.scope === "project" ? "project" : "user"
  // Either explicit user-invocable=false or disable-model-invocation=true should
  // hide the command from the picker. Pickers are the only entry point in this
  // app, so collapsing both flags into one consumer-side bool is fine.
  const hiddenFromPicker = raw.userInvocable === false || raw.disableModelInvocation === true
  return {
    name: raw.name,
    description: raw.description ?? "(custom command)",
    scope,
    argumentHint: raw.argumentHint ?? undefined,
    template: raw.body,
    filePath: raw.path,
    model: raw.model ?? undefined,
    allowedTools: raw.allowedTools ?? undefined,
    paths: raw.paths ?? undefined,
    hiddenFromPicker,
    ...(raw.originDir ? { originDir: raw.originDir } : {}),
  }
}

export { applyTemplate }

// ---- save / delete ------------------------------------------------------

/** Per-command payload accepted by {@link saveCustomSlashCommand}. */
export interface SaveCustomCommandInput {
  /** "user" → ~/.claude/commands; "project" → <cwd>/.claude/commands. */
  scope: "user" | "project"
  /** Filename minus the `.md` extension. Validated to keep it path-safe. */
  name: string
  /** Required for `scope === "project"`, the active session's working dir. */
  cwd?: string | null
  /**
   * Which project directory to write into. An EDIT must pass the directory the
   * command was read from (`projectCommandDirOf(command.originDir)`), or a
   * command that lives in `.cognia/commands` gets a second copy in
   * `.claude/commands` and the `.cognia` one silently keeps shadowing it.
   * A NEW command defaults to `.claude/commands`. Ignored for user scope,
   * which has only one directory.
   */
  dir?: ProjectCommandDir
  description?: string | null
  argumentHint?: string | null
  allowedTools?: string[] | null
  model?: string | null
  /** Markdown body. Carries `$1..$9` / `$ARGUMENTS` placeholders. */
  body: string
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_./-]{0,63}$/

/**
 * Validate a slash-command file basename. Disallows path separators outside
 * a single intra-name slash (which the SDK uses for nested commands like
 * `git/commit`). Throws so the caller surfaces the reason in toast.
 */
export function assertValidCommandName(name: string): void {
  if (!name) throw new Error("Command name is required")
  if (!NAME_PATTERN.test(name)) {
    throw new Error(
      "Command name must start with a letter or digit and contain only letters, digits, `_`, `-`, `.` or `/` (max 64 chars)"
    )
  }
  if (name.includes("..")) {
    throw new Error("Command name cannot contain `..`")
  }
}

/**
 * Build a `<name>.md` file with a YAML frontmatter + body. Empty fields are
 * omitted entirely so the output stays compatible with hand-written commands.
 */
export function buildCommandFile(input: SaveCustomCommandInput): string {
  const front: string[] = []
  const desc = input.description?.trim()
  if (desc) front.push(`description: ${escapeYamlScalar(desc)}`)
  const hint = input.argumentHint?.trim()
  if (hint) front.push(`argument-hint: ${escapeYamlScalar(hint)}`)
  const tools = (input.allowedTools ?? []).map((t) => t.trim()).filter((t) => t.length > 0)
  if (tools.length > 0) {
    front.push(`allowed-tools: [${tools.map((t) => escapeYamlScalar(t)).join(", ")}]`)
  }
  const model = input.model?.trim()
  if (model) front.push(`model: ${escapeYamlScalar(model)}`)

  const body = input.body.replace(/\r\n/g, "\n").replace(/\s+$/g, "")
  if (front.length === 0) {
    // Match the SDK's accepted minimal form — no frontmatter, just body.
    return body + "\n"
  }
  return `---\n${front.join("\n")}\n---\n\n${body}\n`
}

function escapeYamlScalar(value: string): string {
  // Conservative quoting rule: only quote when the scalar contains characters
  // that actually break inline-YAML parsing. `<` / `>` / `?` are fine inside
  // a value position, so an arg-hint like `<file>` stays unquoted. The set
  // below is the union of:
  //   - block-style breakers: `:` (mapping sep), `#` (comment) when adjacent
  //     to a space, plus `"` / `'` / newlines / leading-or-trailing space.
  //   - flow-style breakers (we wrap allowed-tools in [...]): `,` `[` `]`
  //     `{` `}`.
  //   - leading reserved indicators that change the scalar's *type* if
  //     they're the first character: `& * ! | > % @ \` `.
  const hasBlockBreakers = /[\n:#"']/.test(value)
  const hasFlowBreakers = /[,\[\]{}]/.test(value)
  const hasEdgeWhitespace = value.startsWith(" ") || value.endsWith(" ")
  const startsWithReservedIndicator = /^[&*!|>%@`]/.test(value)
  if (hasBlockBreakers || hasFlowBreakers || hasEdgeWhitespace || startsWithReservedIndicator) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
  }
  return value
}

/**
 * Resolve the absolute file path for a command in the given scope. Exposed
 * for tests + the Settings UI's "open file" affordance.
 *
 * `dir` selects between the two project directories and is ignored for user
 * scope, where `~/.claude/commands` is the only one.
 */
export async function resolveCommandPath(
  scope: "user" | "project",
  name: string,
  cwd: string | null | undefined,
  dir: ProjectCommandDir = DEFAULT_PROJECT_COMMAND_DIR
): Promise<string> {
  assertValidCommandName(name)
  const { homeDir, join } = await import("@tauri-apps/api/path")
  const base =
    scope === "user"
      ? await homeDir()
      : (() => {
          if (!cwd) {
            throw new Error("Project-scope commands require a working directory")
          }
          return cwd
        })()
  const [dotDir, commandsDir] = (scope === "user" ? DEFAULT_PROJECT_COMMAND_DIR : dir).split("/")
  return join(base, dotDir, commandsDir, `${name}.md`)
}

/**
 * Persist (create or overwrite) a custom slash-command markdown file. Returns
 * the path it wrote, absolute on the desktop and repo-relative when the write
 * went over the workspace filesystem.
 *
 * The desktop `plugin-fs` write is tried first so behaviour there is unchanged.
 * When it is unreachable, a PROJECT-scope write falls through to the workspace
 * path. A USER-scope write does not, because `~/.claude/commands` is outside
 * every workspace root: it raises {@link GlobalScopeUnavailableError} so the
 * caller can say so.
 */
export async function saveCustomSlashCommand(input: SaveCustomCommandInput): Promise<string> {
  assertValidCommandName(input.name)
  const content = buildCommandFile(input)
  try {
    const { mkdir, writeTextFile, BaseDirectory } = await import("@tauri-apps/plugin-fs")
    void BaseDirectory // re-export referenced for type narrowing in some toolchains
    const path = await resolveCommandPath(input.scope, input.name, input.cwd, input.dir)
    const { dirname } = await import("@tauri-apps/api/path")
    const dir = await dirname(path)
    await mkdir(dir, { recursive: true }).catch((err: unknown) => {
      // Older plugin-fs versions reject when the dir already exists, so tolerate.
      const msg = err instanceof Error ? err.message : String(err)
      if (!/exists|EEXIST/i.test(msg)) throw err
    })
    await writeTextFile(path, content)
    return path
  } catch (err) {
    if (!isHostUnreachable(err)) throw err
    if (input.scope === "user") throw new GlobalScopeUnavailableError()
    if (!input.cwd) throw new Error("Project-scope commands require a working directory")
    return saveWorkspaceCustomCommand({
      root: input.cwd,
      name: input.name,
      ...(input.dir ? { dir: input.dir } : {}),
      content,
    })
  }
}

/** Delete the markdown file backing a custom command. Idempotent. */
export async function deleteCustomSlashCommand(args: {
  scope: "user" | "project"
  name: string
  cwd?: string | null
  dir?: ProjectCommandDir
}): Promise<void> {
  try {
    const path = await resolveCommandPath(args.scope, args.name, args.cwd, args.dir)
    const { remove } = await import("@tauri-apps/plugin-fs")
    await remove(path).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      // Don't surface "file already gone" as an error.
      if (!/not found|ENOENT|no such file/i.test(msg)) throw err
    })
    return
  } catch (err) {
    if (!isHostUnreachable(err)) throw err
    if (args.scope === "user") throw new GlobalScopeUnavailableError()
    if (!args.cwd) throw new Error("Project-scope commands require a working directory")
    await deleteWorkspaceCustomCommand({
      root: args.cwd,
      name: args.name,
      ...(args.dir ? { dir: args.dir } : {}),
    })
  }
}

/**
 * Did this throw because the desktop process is not here, or because the write
 * genuinely failed?
 *
 * Only the first may fall through to the workspace path. An EACCES or a full
 * disk has to reach the user as itself, and quietly writing the file somewhere
 * else instead would be worse than the original failure. Off-desktop the
 * dynamic `import("@tauri-apps/plugin-fs")` and the `invoke` inside it fail
 * with a module/undefined-internals shape, which is what this recognises.
 */
function isHostUnreachable(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return (
    /__TAURI|not\s*tauri|tauri.*not (available|detected|defined)/i.test(message) ||
    /cannot find module|failed to (resolve|fetch) (dynamically imported )?module|dynamically imported module/i.test(
      message
    ) ||
    // `invoke()` off-desktop reads through a missing `window.__TAURI_INTERNALS__`.
    /(read|properties) of (undefined|null)|undefined is not an object/i.test(message)
  )
}
