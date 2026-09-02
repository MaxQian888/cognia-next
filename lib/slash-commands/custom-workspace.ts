/**
 * Project-scope custom slash commands over the workspace filesystem.
 *
 * The Rust scanner (`slash_commands_scan`) and `@tauri-apps/plugin-fs` are
 * `target: "client"`, meaning they run in the desktop process and nowhere
 * else. A browser or phone paired to a host cannot call either, which is why
 * custom commands were desktop-only: not because the feature needs a desktop,
 * but because the only implementation did.
 *
 * `lib/files/workspace-fs.ts` is the companion-reachable path (`fs_*_workspace`
 * is host-targeted and crosses the pairing), so this module re-implements the
 * PROJECT half of the scanner on top of it: walk `.claude/commands` and
 * `.cognia/commands` under one workspace root, parse the same YAML front
 * matter, write and delete the same files.
 *
 * What it deliberately does NOT do is the user-global scope. `~/.claude/commands`
 * is outside every workspace root, so no `fs_*_workspace` call can reach it and
 * no amount of pairing changes that. Callers get that answer as a refusal with
 * a reason, not as an empty list.
 *
 * Precedence matches the Rust scanner exactly: `.cognia/commands` shadows
 * `.claude/commands` for the same command name.
 */

import matter from "gray-matter"

import type { SlashCommand } from "./builtin"

/** The two directories a repository may keep its commands in. */
export const PROJECT_COMMAND_DIRS = [".cognia/commands", ".claude/commands"] as const

export type ProjectCommandDir = (typeof PROJECT_COMMAND_DIRS)[number]

/** The directory a NEW project-scope command is written to. */
export const DEFAULT_PROJECT_COMMAND_DIR: ProjectCommandDir = ".claude/commands"

/** A custom command plus the directory it came from. */
export interface WorkspaceCustomCommand extends SlashCommand {
  /** Repo-relative directory the file was found in. */
  originDir: ProjectCommandDir
}

/**
 * A command file is a prompt, not a document. The Rust counterpart has no
 * explicit byte cap because it reads from local disk. This one crosses a
 * pairing, so it does.
 */
export const WORKSPACE_COMMAND_MAX_BYTES = 256 * 1024

/** How many files one checkout may contribute, per directory. */
export const WORKSPACE_COMMAND_MAX_FILES = 200

export interface WorkspaceCommandDeps {
  walk(root: string, relPath: string): Promise<{ entries: { relPath: string; isDir: boolean }[] }>
  readFile(root: string, relPath: string, maxBytes: number): Promise<string>
  writeFile(root: string, relPath: string, content: string): Promise<void>
  deleteEntry(root: string, relPath: string): Promise<void>
}

/**
 * Lazy on every field so a caller that injects all of them (tests) does not
 * drag the Tauri transport in behind them.
 */
const DEFAULT_DEPS: WorkspaceCommandDeps = {
  walk: async (root, relPath) => {
    const { walkWorkspace } = await import("@/lib/files/workspace-fs")
    const result = await walkWorkspace(root, {
      relPath,
      // A `.claude` directory is `.gitignore`d in plenty of repositories, and
      // an ignored command file is still a command file the user wrote.
      includeIgnored: true,
      maxEntries: WORKSPACE_COMMAND_MAX_FILES,
    })
    return { entries: result.entries.map((e) => ({ relPath: e.relPath, isDir: e.isDir })) }
  },
  readFile: async (root, relPath, maxBytes) => {
    const { readWorkspaceFile } = await import("@/lib/files/workspace-fs")
    return readWorkspaceFile(root, relPath, maxBytes)
  },
  writeFile: async (root, relPath, content) => {
    const { writeWorkspaceFile } = await import("@/lib/files/workspace-fs")
    await writeWorkspaceFile(root, relPath, content)
  },
  deleteEntry: async (root, relPath) => {
    const { deleteWorkspaceEntry } = await import("@/lib/files/workspace-fs")
    await deleteWorkspaceEntry(root, relPath)
  },
}

function resolveDeps(deps: Partial<WorkspaceCommandDeps>): WorkspaceCommandDeps {
  return { ...DEFAULT_DEPS, ...deps }
}

/** `.claude/commands/git/commit.md` under `.claude/commands` becomes `git/commit`. */
function commandNameFromRelPath(dir: ProjectCommandDir, relPath: string): string | null {
  const normalized = relPath.replaceAll("\\", "/").replace(/^\.\//, "")
  const prefix = `${dir}/`
  if (!normalized.startsWith(prefix)) return null
  const rest = normalized.slice(prefix.length)
  if (!rest.toLowerCase().endsWith(".md")) return null
  const name = rest.slice(0, -3)
  return name.length > 0 ? name : null
}

function asStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const list = value.filter((item): item is string => typeof item === "string")
  return list.length > 0 ? list : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined
}

/**
 * Parse one command file. Mirrors `collect_command_files` in
 * `crates/cognia-files/src/files.rs`: the same front-matter keys, the same
 * `hiddenFromPicker` collapse, the same "body is the prompt" rule.
 */
export function parseWorkspaceCommandFile(input: {
  name: string
  dir: ProjectCommandDir
  filePath: string
  raw: string
}): WorkspaceCustomCommand {
  const parsed = matter(input.raw)
  const data = (parsed.data ?? {}) as Record<string, unknown>
  const hiddenFromPicker =
    data["user-invocable"] === false || data["disable-model-invocation"] === true
  const allowedTools = asStringList(data["allowed-tools"])
  const paths = asStringList(data.paths)
  return {
    name: input.name,
    description: asString(data.description) ?? "(custom command)",
    scope: "project",
    template: parsed.content.replace(/^\s+/, ""),
    filePath: input.filePath,
    originDir: input.dir,
    hiddenFromPicker,
    ...(asString(data["argument-hint"]) ? { argumentHint: data["argument-hint"] as string } : {}),
    ...(asString(data.model) ? { model: data.model as string } : {}),
    ...(allowedTools ? { allowedTools } : {}),
    ...(paths ? { paths } : {}),
  }
}

/**
 * Every project-scope command under `root`, with `.cognia` shadowing `.claude`.
 *
 * A directory that does not exist is not an error, because most repositories
 * have neither. A failed walk yields nothing for that directory and the other
 * one still answers.
 */
export async function listWorkspaceCustomCommands(
  root: string | null | undefined,
  deps: Partial<WorkspaceCommandDeps> = {}
): Promise<WorkspaceCustomCommand[]> {
  const workspaceRoot = root?.trim()
  if (!workspaceRoot) return []
  const resolved = resolveDeps(deps)
  const byName = new Map<string, WorkspaceCustomCommand>()

  for (const dir of PROJECT_COMMAND_DIRS) {
    let relPaths: string[]
    try {
      const walked = await resolved.walk(workspaceRoot, dir)
      relPaths = walked.entries
        .filter((entry) => !entry.isDir)
        .map((entry) => entry.relPath)
        .slice(0, WORKSPACE_COMMAND_MAX_FILES)
    } catch {
      continue
    }
    for (const relPath of relPaths) {
      const name = commandNameFromRelPath(dir, relPath)
      // `.cognia` is walked first, so a name it already claimed wins.
      if (!name || byName.has(name)) continue
      let raw: string
      try {
        raw = await resolved.readFile(workspaceRoot, relPath, WORKSPACE_COMMAND_MAX_BYTES)
      } catch {
        continue
      }
      try {
        byName.set(name, parseWorkspaceCommandFile({ name, dir, filePath: relPath, raw }))
      } catch {
        // Malformed front matter makes one command unusable, not the picker.
        continue
      }
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export interface WorkspaceCommandWriteInput {
  root: string
  /** Filename minus `.md`. Already validated by the caller. */
  name: string
  dir?: ProjectCommandDir
  content: string
}

/** Repo-relative path of a command file. */
export function workspaceCommandRelPath(
  name: string,
  dir: ProjectCommandDir = DEFAULT_PROJECT_COMMAND_DIR
): string {
  return `${dir}/${name}.md`
}

/** Write (create or overwrite) a project-scope command file. Returns its relative path. */
export async function saveWorkspaceCustomCommand(
  input: WorkspaceCommandWriteInput,
  deps: Partial<WorkspaceCommandDeps> = {}
): Promise<string> {
  const relPath = workspaceCommandRelPath(input.name, input.dir ?? DEFAULT_PROJECT_COMMAND_DIR)
  await resolveDeps(deps).writeFile(input.root, relPath, input.content)
  return relPath
}

/** Delete a project-scope command file. Already-gone is success, as on desktop. */
export async function deleteWorkspaceCustomCommand(
  input: { root: string; name: string; dir?: ProjectCommandDir },
  deps: Partial<WorkspaceCommandDeps> = {}
): Promise<void> {
  const relPath = workspaceCommandRelPath(input.name, input.dir ?? DEFAULT_PROJECT_COMMAND_DIR)
  try {
    await resolveDeps(deps).deleteEntry(input.root, relPath)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (!/not found|ENOENT|no such file|does not exist/i.test(message)) throw err
  }
}
