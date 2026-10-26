/**
 * `cognia-agent prompts …` — manage the Prompt Center's code-owned prompt
 * overrides (ADR-0236) in this CLI's own store, for standalone and headless
 * hosts that have no Settings window.
 *
 *   list [--group g] [--modified] [--json]          every prompt slot, and where it is overridden
 *   show <id> [--json]                              shipped text, contract and every override
 *   set <id> [--scope s] [--target t] [--file f]    publish an override (body from --file or stdin)
 *   reset <id> [--scope s] [--target t]             return a slot to inheritance (history kept)
 *   export [--output f] [--scope s]                 write published overrides as a portable profile
 *   import <file> [--map scope:from=to[,…]] [--yes] preview a profile; apply it with --yes
 *
 * `--scope workspace` without `--target` means the workspace that mounts the
 * current directory, the same rule a CLI turn resolves against. The store is
 * the CLI's (`~/.cognia`); the desktop app keeps its own, and a profile moves
 * overrides between them.
 */

import fs from "node:fs"
import path from "node:path"

import { listPromptDefinitions, getPromptDefinition } from "@/lib/prompts/catalog"
import {
  applyPromptProfileImport,
  exportPromptProfile,
  importTargetKey,
  parsePromptProfile,
  previewPromptProfileImport,
  serializePromptProfile,
  type PromptImportTargetMap,
} from "@/lib/prompts/profile"
import { resolvePrompt } from "@/lib/prompts/resolve"
import {
  PromptScopeError,
  PromptValidationError,
  listPromptSlots,
  publishPromptBody,
  readPromptSlot,
  resetPromptToInherited,
} from "@/lib/prompts/service"
import { loadPromptOverrideSnapshot } from "@/lib/prompts/snapshot"
import type { PromptDefinitionV1, PromptScope, PromptTargetRef } from "@/lib/prompts/types"

import { ensureCliDb, type CliDbHandle } from "../db/bootstrap"
import { boolFlag, stringFlag, type ParsedArgs } from "./args"
import { realOutput, type OutputSink } from "./output"

export interface PromptsCommandDeps {
  out?: OutputSink
  cwd?: string
  /** Opens the CLI store; defaults to `ensureCliDb()`. */
  openDb?: () => Promise<Pick<CliDbHandle, "mode" | "flush" | "dispose">>
  findWorkspaceId?: (cwd: string) => Promise<string | null>
  readStdin?: () => Promise<string>
  readFile?: (file: string) => string
  writeFile?: (file: string, text: string) => void
}

const SCOPES: readonly PromptScope[] = ["account", "workspace", "agent", "session"]

const USAGE =
  "prompts: expected a subcommand — list | show <id> | set <id> | reset <id> | export | import <file>"

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString("utf8")
}

class UsageError extends Error {}

export async function promptsCommand(
  args: ParsedArgs,
  deps: PromptsCommandDeps = {}
): Promise<number> {
  const out = deps.out ?? realOutput
  const sub = args.subcommand
  if (!sub || !["list", "show", "set", "reset", "export", "import"].includes(sub)) {
    out.error(USAGE)
    return 2
  }
  const db = await (deps.openDb ?? (() => ensureCliDb()))()
  const writes = sub === "set" || sub === "reset" || (sub === "import" && boolFlag(args, "yes"))
  if (writes && db.mode === "read-only") {
    out.error(
      "prompts: another cognia process owns this store, so it is open read-only. Stop that process (or set COGNIA_HOME) and run again. Nothing was changed."
    )
    await db.dispose()
    return 1
  }
  try {
    await loadPromptOverrideSnapshot()
    const code = await runSubcommand(sub, args, deps, out)
    if (writes) await db.flush()
    return code
  } catch (error) {
    if (error instanceof UsageError) {
      out.error(error.message)
      return 2
    }
    if (error instanceof PromptValidationError) {
      out.error(`prompts: the text was not published — ${describeIssues(error)}`)
      return 1
    }
    if (error instanceof PromptScopeError) {
      out.error(`prompts: ${error.message}`)
      return 2
    }
    out.error(`prompts: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  } finally {
    await db.dispose()
  }
}

function describeIssues(error: PromptValidationError): string {
  return error.issues
    .map((issue) => {
      switch (issue.code) {
        case "too-long":
          return `longer than ${issue.limit} characters (${issue.length})`
        case "missing-fragment":
          return `must keep ${JSON.stringify(issue.fragment)}`
        case "missing-variable":
          return `must use {{${issue.name}}}`
        case "unknown-variable":
          return `{{${issue.name}}} is not a variable of this prompt`
        default:
          return issue.code
      }
    })
    .join("; ")
}

async function runSubcommand(
  sub: string,
  args: ParsedArgs,
  deps: PromptsCommandDeps,
  out: OutputSink
): Promise<number> {
  switch (sub) {
    case "list":
      return listCommand(args, out)
    case "show":
      return showCommand(args, out)
    case "set":
      return setCommand(args, deps, out)
    case "reset":
      return resetCommand(args, deps, out)
    case "export":
      return exportCommand(args, deps, out)
    default:
      return importCommand(args, deps, out)
  }
}

function definitionArg(args: ParsedArgs, verb: string): PromptDefinitionV1 {
  const id = args.positionals[0]
  if (!id) throw new UsageError(`prompts ${verb}: usage — prompts ${verb} <id>`)
  const def = getPromptDefinition(id)
  if (!def) throw new UsageError(`prompts ${verb}: unknown prompt "${id}" (see \`prompts list\`)`)
  return def
}

async function targetArgs(
  args: ParsedArgs,
  def: PromptDefinitionV1,
  deps: PromptsCommandDeps,
  verb: string
): Promise<PromptTargetRef> {
  const scope = (stringFlag(args, "scope") ?? "account") as PromptScope
  if (!SCOPES.includes(scope)) {
    throw new UsageError(`prompts ${verb}: --scope must be one of ${SCOPES.join(", ")}`)
  }
  if (!def.scopes.includes(scope)) {
    throw new UsageError(
      def.operation === "inspect-only"
        ? `prompts ${verb}: ${def.id} is inspect-only; the host depends on its exact text`
        : `prompts ${verb}: ${def.id} can be overridden at ${def.scopes.join(", ")}, not ${scope}`
    )
  }
  if (scope === "account") return { scope, targetId: "" }
  const explicit = stringFlag(args, "target")
  if (explicit) return { scope, targetId: explicit }
  if (scope === "workspace") {
    const cwd = deps.cwd ?? process.cwd()
    const find =
      deps.findWorkspaceId ??
      (async (dir: string) => (await import("@/lib/db/projects")).findWorkspaceIdForPath(dir))
    const workspaceId = await find(cwd)
    if (workspaceId) return { scope, targetId: workspaceId }
    throw new UsageError(
      `prompts ${verb}: no workspace mounts ${cwd}; pass --target <workspace id>`
    )
  }
  throw new UsageError(`prompts ${verb}: --scope ${scope} needs --target <id>`)
}

async function listCommand(args: ParsedArgs, out: OutputSink): Promise<number> {
  const group = stringFlag(args, "group")
  const modifiedOnly = boolFlag(args, "modified")
  const rows = []
  for (const def of listPromptDefinitions()) {
    if (group && def.group !== group) continue
    const slots = (await listPromptSlots(def.id)).filter((slot) => slot.active)
    if (modifiedOnly && slots.length === 0) continue
    rows.push({
      id: def.id,
      group: def.group,
      kind: def.kind,
      operation: def.operation,
      risk: def.risk,
      hosts: def.hosts,
      scopes: def.scopes,
      overrides: slots.map((slot) => ({
        scope: slot.binding!.scope,
        targetId: slot.binding!.targetId,
      })),
    })
  }
  if (boolFlag(args, "json")) {
    out.json(rows)
    return 0
  }
  if (rows.length === 0) {
    out.write(modifiedOnly ? "No prompt is overridden.\n" : "No prompts match.\n")
    return 0
  }
  for (const row of rows) {
    const where = row.overrides.length
      ? `  overridden: ${row.overrides.map((o) => (o.targetId ? `${o.scope}:${o.targetId}` : o.scope)).join(", ")}`
      : ""
    const tag = row.operation === "inspect-only" ? " (inspect-only)" : ""
    out.write(`${row.id}  [${row.group}]${tag}${where}\n`)
  }
  return 0
}

async function showCommand(args: ParsedArgs, out: OutputSink): Promise<number> {
  const def = definitionArg(args, "show")
  const slots = (await listPromptSlots(def.id)).filter((slot) => slot.binding)
  const overrides = slots.map((slot) => ({
    scope: slot.binding!.scope,
    targetId: slot.binding!.targetId,
    rev: slot.binding!.rev,
    published: slot.active
      ? { revisionId: slot.active.id, body: slot.active.body, createdAt: slot.active.createdAt }
      : null,
    draft: slot.draft ? { revisionId: slot.draft.id, body: slot.draft.body } : null,
  }))
  const accountText = resolvePrompt(def).body
  if (boolFlag(args, "json")) {
    out.json({
      id: def.id,
      group: def.group,
      kind: def.kind,
      operation: def.operation,
      risk: def.risk,
      hosts: def.hosts,
      scopes: def.scopes,
      activation: def.activation,
      contractVersion: def.contractVersion,
      variables: def.variables,
      requiredFragments: def.requiredFragments,
      outputContract: def.outputContract ?? null,
      maxChars: def.maxChars,
      consumers: def.consumers,
      shippedBody: def.defaultBody,
      accountBody: accountText,
      overrides,
    })
    return 0
  }
  out.write(`${def.id}  [${def.group}, ${def.kind}, ${def.operation}, risk ${def.risk}]\n`)
  out.write(`hosts: ${def.hosts.join(", ")}   scopes: ${def.scopes.join(", ") || "none"}\n`)
  if (def.variables.length > 0) {
    out.write(
      `variables: ${def.variables.map((v) => `{{${v.name}}}${v.required ? " (required)" : ""}`).join(", ")}\n`
    )
  }
  if (def.requiredFragments.length > 0) {
    out.write(`must keep: ${def.requiredFragments.map((f) => JSON.stringify(f)).join(", ")}\n`)
  }
  if (def.outputContract) out.write(`output: ${def.outputContract}\n`)
  out.write(`\n--- shipped ---\n${def.defaultBody}\n`)
  for (const override of overrides) {
    const label = override.targetId ? `${override.scope}:${override.targetId}` : override.scope
    if (override.published) {
      out.write(`\n--- ${label} (published ${override.published.revisionId}) ---\n`)
      out.write(`${override.published.body}\n`)
    }
    if (override.draft) {
      out.write(`\n--- ${label} draft (not active) ---\n${override.draft.body}\n`)
    }
  }
  return 0
}

async function setCommand(
  args: ParsedArgs,
  deps: PromptsCommandDeps,
  out: OutputSink
): Promise<number> {
  const def = definitionArg(args, "set")
  const target = await targetArgs(args, def, deps, "set")
  const file = stringFlag(args, "file")
  const raw = file
    ? (deps.readFile ?? ((f: string) => fs.readFileSync(f, "utf8")))(path.resolve(file))
    : await (deps.readStdin ?? readAllStdin)()
  // A file or heredoc ends in a newline the author did not mean as text.
  const body = raw.replace(/\r?\n$/, "")
  const slot = await readPromptSlot(def.id, target)
  const binding = await publishPromptBody({
    def,
    target,
    body,
    expectedRev: slot.binding?.rev ?? 0,
    origin: "cli",
  })
  out.write(
    `Published ${def.id} at ${describeTarget(target)} (revision ${binding.activeRevisionId}).\n`
  )
  return 0
}

async function resetCommand(
  args: ParsedArgs,
  deps: PromptsCommandDeps,
  out: OutputSink
): Promise<number> {
  const def = definitionArg(args, "reset")
  const target = await targetArgs(args, def, deps, "reset")
  const slot = await readPromptSlot(def.id, target)
  if (!slot.binding || !slot.active) {
    out.write(`${def.id} has no override at ${describeTarget(target)}; nothing to reset.\n`)
    return 0
  }
  await resetPromptToInherited({ def, target, expectedRev: slot.binding.rev, origin: "cli" })
  out.write(`Reset ${def.id} at ${describeTarget(target)}; it inherits again.\n`)
  return 0
}

function describeTarget(target: PromptTargetRef): string {
  return target.targetId ? `${target.scope} ${target.targetId}` : "the account"
}

async function exportCommand(
  args: ParsedArgs,
  deps: PromptsCommandDeps,
  out: OutputSink
): Promise<number> {
  const scope = stringFlag(args, "scope") as PromptScope | undefined
  if (scope && !SCOPES.includes(scope)) {
    throw new UsageError(`prompts export: --scope must be one of ${SCOPES.join(", ")}`)
  }
  const profile = await exportPromptProfile(scope ? { scopes: [scope] } : {})
  const text = serializePromptProfile(profile)
  const file = stringFlag(args, "output")
  if (!file) {
    out.write(text)
    return 0
  }
  ;(deps.writeFile ?? ((f: string, t: string) => fs.writeFileSync(f, t, { mode: 0o600 })))(
    path.resolve(file),
    text
  )
  out.write(`Exported ${profile.entries.length} override(s) to ${file}.\n`)
  return 0
}

function mapFlags(args: ParsedArgs): PromptImportTargetMap {
  // `--map` repeats; the parser keeps the last value of a flag, so the
  // positional form `scope:from=to` after the file is accepted as well.
  const specs = [
    ...String(stringFlag(args, "map") ?? "")
      .split(",")
      .filter(Boolean),
    ...args.positionals.slice(1),
  ]
  const map: Record<string, string> = {}
  for (const spec of specs) {
    const match = /^(workspace|agent|session):([^=]+)=(.+)$/.exec(spec.trim())
    if (!match) {
      throw new UsageError(
        `prompts import: --map expects scope:from=to (e.g. workspace:ws_old=ws_new), got "${spec}"`
      )
    }
    map[importTargetKey({ scope: match[1] as PromptScope, targetId: match[2] })] = match[3]
  }
  return map
}

async function importCommand(
  args: ParsedArgs,
  deps: PromptsCommandDeps,
  out: OutputSink
): Promise<number> {
  const file = args.positionals[0]
  if (!file) throw new UsageError("prompts import: usage — prompts import <file> [--map …] [--yes]")
  const text = (deps.readFile ?? ((f: string) => fs.readFileSync(f, "utf8")))(path.resolve(file))
  const profile = parsePromptProfile(text)
  const preview = await previewPromptProfileImport(profile, mapFlags(args))
  for (const item of preview) {
    const where = item.target
      ? describeTarget(item.target)
      : `${item.entry.scope} ${item.entry.targetId}`
    const notes = [
      item.upstreamChanged ? "written against an older shipped default; review it" : "",
      item.issues.length ? item.issues.map((issue) => issue.code).join(", ") : "",
    ].filter(Boolean)
    out.write(
      `${item.status.padEnd(18)} ${item.entry.promptId} @ ${where}${notes.length ? `  (${notes.join("; ")})` : ""}\n`
    )
  }
  const applicable = preview.filter((item) => item.status === "new" || item.status === "replace")
  if (!boolFlag(args, "yes")) {
    out.write(
      `\n${applicable.length} of ${preview.length} entr${preview.length === 1 ? "y" : "ies"} would apply. Run again with --yes to publish them.\n`
    )
    return 0
  }
  const result = await applyPromptProfileImport(
    preview,
    new Set(applicable.map((item) => item.index))
  )
  out.write(`\nPublished ${result.applied} override(s).\n`)
  for (const item of result.conflicted) {
    out.error(
      `prompts import: ${item.entry.promptId} changed since the preview and was left as it is; run the import again to review it.`
    )
  }
  return result.conflicted.length > 0 ? 1 : 0
}
