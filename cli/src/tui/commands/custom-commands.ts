/**
 * Discover user-authored custom slash commands from disk and register them as
 * CLI commands. Replicates the Rust `slash_commands_scan` (`src-tauri/src/files.rs`)
 * for the standalone Node CLI (which can't call the Tauri command): scan the
 * `.claude/commands` and `.cognia/commands` dirs under the project and OS home,
 * parse YAML frontmatter, and treat the body as a prompt template.
 *
 * Each command's handler returns a `send` effect carrying the applied template
 * (`$ARGUMENTS` / `$1..$9` filled from what the user typed), reusing the shared
 * pure `applyTemplate`. Collisions with a built-in command are skipped (never
 * throw), so a custom `goal.md` can't crash the TUI. CLI is English-only.
 */
import nodeFs from "node:fs/promises"
import path from "node:path"
import matter from "gray-matter"

import { applyTemplate } from "@/lib/slash-commands/apply-template"
import { getCommand, registerCommand } from "./registry"
import type { CommandDescriptor } from "./types"

/** The minimal fs surface discovery needs — injectable for tests. */
export interface CommandFs {
  exists(p: string): Promise<boolean>
  readDir(p: string): Promise<string[]>
  readText(p: string): Promise<string>
  isDirectory(p: string): Promise<boolean>
}

const defaultFs: CommandFs = {
  async exists(p) {
    try {
      await nodeFs.access(p)
      return true
    } catch {
      return false
    }
  },
  async readDir(p) {
    try {
      return await nodeFs.readdir(p)
    } catch {
      return []
    }
  },
  readText: (p) => nodeFs.readFile(p, "utf8"),
  async isDirectory(p) {
    try {
      return (await nodeFs.stat(p)).isDirectory()
    } catch {
      return false
    }
  },
}

/** Depth guard matching the Rust scanner (avoids runaway recursion). */
const MAX_DEPTH = 8

export interface LoadCustomCommandsOptions {
  cwd: string
  osHome: string
  fs?: CommandFs
}

export interface RegisterCustomCommandsOptions extends LoadCustomCommandsOptions {
  /** Name-taken predicate (defaults to the live registry). Injected in tests. */
  isTaken?: (name: string) => boolean
}

/** Commands dirs, project first so it wins a name collision. */
function commandRoots(cwd: string, osHome: string): string[] {
  return [
    path.join(cwd, ".claude", "commands"),
    path.join(cwd, ".cognia", "commands"),
    path.join(osHome, ".claude", "commands"),
    path.join(osHome, ".cognia", "commands"),
  ]
}

/** Recursively collect `*.md` file paths under `dir`. */
async function walkMarkdown(fs: CommandFs, dir: string, depth: number): Promise<string[]> {
  if (depth > MAX_DEPTH) return []
  const names = await fs.readDir(dir)
  const files: string[] = []
  for (const name of names) {
    const full = path.join(dir, name)
    if (await fs.isDirectory(full)) {
      files.push(...(await walkMarkdown(fs, full, depth + 1)))
    } else if (name.toLowerCase().endsWith(".md")) {
      files.push(full)
    }
  }
  return files
}

/** Command name from a file path: relative to root, `.md` stripped, `/`-joined. */
function commandName(root: string, file: string): string {
  const rel = path.relative(root, file)
  return rel.replace(/\.md$/i, "").split(path.sep).join("/")
}

function firstString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

/** Parse one command file into a descriptor, or null when unparseable. */
function toDescriptor(name: string, raw: string): CommandDescriptor | null {
  let data: Record<string, unknown>
  let body: string
  try {
    const parsed = matter(raw)
    data = parsed.data as Record<string, unknown>
    body = parsed.content
  } catch {
    return null // malformed frontmatter — a broken file must not break the picker
  }
  const description = firstString(data.description) ?? "(custom command)"
  const argumentHint = firstString(data["argument-hint"])
  const hidden = data["user-invocable"] === false || data["disable-model-invocation"] === true
  return {
    name,
    description,
    category: "custom",
    ...(argumentHint ? { argumentHint } : {}),
    ...(hidden ? { hidden: true } : {}),
    handler: (ctx) => ({ kind: "send", prompt: applyTemplate(body, ctx.args) }),
  }
}

/** Discover custom-command descriptors from disk (first-root-wins on name). */
export async function loadCustomCommandDescriptors(
  opts: LoadCustomCommandsOptions
): Promise<CommandDescriptor[]> {
  const fs = opts.fs ?? defaultFs
  const byName = new Map<string, CommandDescriptor>()
  for (const root of commandRoots(opts.cwd, opts.osHome)) {
    if (!(await fs.exists(root))) continue
    const files = await walkMarkdown(fs, root, 0)
    files.sort()
    for (const file of files) {
      const name = commandName(root, file)
      if (!name || byName.has(name)) continue
      let raw: string
      try {
        raw = await fs.readText(file)
      } catch {
        continue // unreadable — skip
      }
      const descriptor = toDescriptor(name, raw)
      if (descriptor) byName.set(name, descriptor)
    }
  }
  return [...byName.values()]
}

let registered = false

/**
 * Discover + register custom commands. Idempotent (guarded), and per-descriptor
 * it registers only when the name is free — a custom command that collides with a
 * built-in is skipped rather than throwing the registry's duplicate error.
 * Returns the descriptors actually registered.
 */
export async function registerCustomCommands(
  opts: RegisterCustomCommandsOptions
): Promise<CommandDescriptor[]> {
  if (registered) return []
  registered = true
  const isTaken = opts.isTaken ?? ((name: string) => getCommand(name) !== undefined)
  const descriptors = await loadCustomCommandDescriptors(opts)
  const added: CommandDescriptor[] = []
  for (const descriptor of descriptors) {
    if (isTaken(descriptor.name)) continue
    try {
      registerCommand(descriptor)
      added.push(descriptor)
    } catch {
      // lost a race to another registrant — skip
    }
  }
  return added
}

/** Test-only: allow re-registration after a registry reset. */
export function __resetCustomCommandsForTesting(): void {
  registered = false
}
