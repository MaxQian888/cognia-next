// Bridge between the Rust `slash_commands_scan` command and the frontend
// SlashCommand model. Custom markdown commands always end up as templates —
// their body text is the prompt; we never run them as Action handlers.
//
// Save / delete go through `@tauri-apps/plugin-fs` directly rather than a
// dedicated Rust command — the surface is small (writeTextFile + remove +
// mkdir) and reusing the JS-side path keeps the Rust binary tight. Stage 3
// of the ClaudeCode 完整化 plan (Phase 7c).

import { invoke } from "@tauri-apps/api/core"
import type { SlashCommand, SlashScope } from "./builtin"
import { applyTemplate } from "./builtin"

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
}

/**
 * Discover custom slash commands at `<cwd>/.claude/commands/**\/*.md` and
 * `~/.claude/commands/**\/*.md`. Returns an empty list when the platform is
 * not Tauri (web-only dev mode) or both directories are missing. Errors are
 * caught and logged — a broken command file should not break the whole
 * picker.
 */
export async function loadCustomSlashCommands(
  cwd: string | null | undefined
): Promise<SlashCommand[]> {
  try {
    const raw = await invoke<RawCommand[]>("slash_commands_scan", {
      cwd: cwd ?? null,
    })
    return raw.map(toSlashCommand)
  } catch (err) {
    if (typeof window !== "undefined") {
      // The Tauri-not-detected case is the most common reason this runs in a
      // plain Next.js dev server — degrade gracefully without spamming the UI.
      console.debug("loadCustomSlashCommands skipped:", err)
    }
    return []
  }
}

function toSlashCommand(raw: RawCommand): SlashCommand {
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
  /** Required for `scope === "project"` — the active session's working dir. */
  cwd?: string | null
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
 */
export async function resolveCommandPath(
  scope: "user" | "project",
  name: string,
  cwd: string | null | undefined
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
  return join(base, ".claude", "commands", `${name}.md`)
}

/**
 * Persist (create or overwrite) a custom slash-command markdown file. Throws
 * when not running inside Tauri — the Settings UI gates this behind an
 * `isTauri()` check + explanatory banner.
 */
export async function saveCustomSlashCommand(input: SaveCustomCommandInput): Promise<string> {
  assertValidCommandName(input.name)
  const { mkdir, writeTextFile, BaseDirectory } = await import("@tauri-apps/plugin-fs")
  void BaseDirectory // re-export referenced for type narrowing in some toolchains
  const path = await resolveCommandPath(input.scope, input.name, input.cwd)
  const { dirname } = await import("@tauri-apps/api/path")
  const dir = await dirname(path)
  await mkdir(dir, { recursive: true }).catch((err: unknown) => {
    // Older plugin-fs versions reject when the dir already exists; tolerate.
    const msg = err instanceof Error ? err.message : String(err)
    if (!/exists|EEXIST/i.test(msg)) throw err
  })
  const content = buildCommandFile(input)
  await writeTextFile(path, content)
  return path
}

/** Delete the markdown file backing a custom command. Idempotent. */
export async function deleteCustomSlashCommand(args: {
  scope: "user" | "project"
  name: string
  cwd?: string | null
}): Promise<void> {
  const path = await resolveCommandPath(args.scope, args.name, args.cwd)
  const { remove } = await import("@tauri-apps/plugin-fs")
  await remove(path).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err)
    // Don't surface "file already gone" as an error.
    if (!/not found|ENOENT|no such file/i.test(msg)) throw err
  })
}
