// Codex App control operations, one per process: `control-cli.mjs <op>` with a
// JSON request on stdin and one `{ ok, result | error }` JSON line on stdout.
// Spawned by `run_cdp_control` in crates/cognia-codex-app/src/lib.rs.

import { randomBytes } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, join, resolve } from "node:path"

import {
  bootstrapCodexTask,
  interruptCodexTask,
  invokeCodexComposerContext,
  listCodexComposerContexts,
  openCodexTask,
  submitCodexComposerPrompt,
} from "./cdp-bootstrap.ts"
import { ensureCodexCdpRuntime } from "./cdp-runtime.ts"
import {
  findNewTurnId,
  findRolloutByMarker,
  findRolloutByThreadId,
  readProjectedRollout,
} from "./rollout-mirror.ts"
import type { RolloutEvent } from "./rollout-mirror.ts"
import { defaultStateDir } from "./shared.ts"
import { listCodexTasks } from "./task-index.ts"

/** A control request as parsed from stdin: validated field by field where read. */
type ControlRequest = Record<string, unknown>

const CDP_PORT = 9229
const THREAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_STDIN_BYTES = 8 << 20

function requiredString(value: unknown, name: string, maxLength = 64 * 1024): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} is required`)
  if (value.length > maxLength) throw new Error(`${name} exceeds ${maxLength} characters`)
  return value.trim()
}

function threadId(value: unknown): string {
  const normalized = requiredString(value, "threadId", 64)
  if (!THREAD_ID_PATTERN.test(normalized)) throw new Error("threadId is invalid")
  return normalized
}

/** Read the whole request (bounded) and parse it; an empty body is `{}`. */
export async function readInput(
  stream: AsyncIterable<unknown> = process.stdin
): Promise<ControlRequest> {
  let value = ""
  for await (const chunk of stream) {
    value += String(chunk)
    if (Buffer.byteLength(value) > MAX_STDIN_BYTES) throw new Error("control request is too large")
  }
  if (!value.trim()) return {}
  const parsed: unknown = JSON.parse(value)
  // Operations only read named fields, so a non-object body reads like `{}`.
  return typeof parsed === "object" && parsed !== null ? (parsed as ControlRequest) : {}
}

function sessionsRoot(): string {
  const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex")
  return join(codexHome, "sessions")
}

async function ensureRuntime(autoRestart: boolean) {
  return ensureCodexCdpRuntime({
    cdpPort: CDP_PORT,
    autoRestart,
    stateDir: defaultStateDir(),
    timeoutMs: autoRestart ? 60_000 : 2_500,
  })
}

/** A request's `input` items folded into one prompt plus the local files to attach. */
export function normalizedInput(items: unknown): { prompt: string; filePaths: string[] } {
  if (!Array.isArray(items) || items.length === 0) throw new Error("input is required")
  const prompt: string[] = []
  const filePaths: string[] = []
  for (const raw of items as unknown[]) {
    if (!raw || typeof raw !== "object") throw new Error("input item is invalid")
    const item = raw as Record<string, unknown>
    if (item.type === "text") prompt.push(requiredString(item.text, "input.text"))
    else if (item.type === "image" || item.type === "audio") {
      prompt.push(requiredString(item.url, `input.${item.type}.url`, 8_000))
    } else if (
      item.type === "localImage" ||
      item.type === "localAudio" ||
      item.type === "mention"
    ) {
      filePaths.push(resolve(requiredString(item.path, `input.${item.type}.path`, 4_096)))
    } else if (item.type === "skill") {
      const name = requiredString(item.name, "input.skill.name", 256)
      const path = resolve(requiredString(item.path, "input.skill.path", 4_096))
      prompt.push(`Use the installed ${name} skill for this request.`)
      filePaths.push(path)
    } else throw new Error(`unsupported input type: ${String(item.type)}`)
  }
  return {
    prompt: prompt.join("\n\n") || "Use the attached local context for this request.",
    filePaths: [...new Set(filePaths)],
  }
}

/** The task fields `taskAsThread` reads (a listed task, or a synthesized one). */
interface TaskLike {
  id: string
  preview?: string | null
  name?: string | null
  title?: string | null
  cwd?: unknown
  createdAt?: string | null
  updatedAt?: string | null
}

/** A Codex task in the shape the app's thread view expects. */
export function taskAsThread(task: TaskLike, turns: RolloutEvent[] = []) {
  const lastTurn = turns.filter((event) => event.kind === "turn").at(-1)
  return {
    id: task.id,
    sessionId: task.id,
    parentThreadId: null,
    preview: task.preview || "",
    name: task.name ?? task.title ?? null,
    cwd: task.cwd,
    createdAt: task.createdAt ? Math.floor(Date.parse(task.createdAt) / 1000) : 0,
    updatedAt: task.updatedAt ? Math.floor(Date.parse(task.updatedAt) / 1000) : 0,
    status: { type: lastTurn?.status === "started" ? "active" : "idle" },
    turns,
  }
}

async function listTasks(request: ControlRequest) {
  const result = await listCodexTasks({
    limit: request.limit ?? 50,
    query: request.searchTerm ?? "",
    archived: request.archived == null ? "active" : request.archived ? "archived" : "active",
    scope: "workspace",
    workspace: requiredString(request.cwd, "cwd", 4_096),
    cursor: request.cursor ?? null,
  })
  return { data: result.tasks.map((task) => taskAsThread(task)), nextCursor: result.nextCursor }
}

async function readTask(request: ControlRequest) {
  const id = threadId(request.threadId)
  const result = await listCodexTasks({
    limit: 50,
    query: id,
    archived: "all",
    scope: "all",
  })
  const task = result.tasks.find((candidate) => candidate.id === id)
  if (!task) throw new Error(`Codex App task not found: ${id}`)
  let turns: RolloutEvent[] = []
  if (request.includeTurns !== false) {
    const rollout = await findRolloutByThreadId(sessionsRoot(), id)
    if (rollout) turns = await readProjectedRollout(rollout)
  }
  return { thread: taskAsThread(task, turns) }
}

async function createTask(request: ControlRequest) {
  await ensureRuntime(true)
  const input = normalizedInput(request.input)
  const nonce = randomBytes(12).toString("hex")
  const marker = `COGNIA_BOOTSTRAP:${nonce}`
  const sinceMs = Date.now() - 2_000
  await bootstrapCodexTask(
    {
      prompt: input.prompt,
      browserUrl: request.browserUrl,
      workspace: requiredString(request.cwd, "cwd", 4_096),
      nonce,
      filePaths: input.filePaths,
    },
    { cdpPort: CDP_PORT }
  )
  const deadline = Date.now() + 60_000
  let rollout: string | null = null
  while (Date.now() < deadline && !rollout) {
    rollout = await findRolloutByMarker(sessionsRoot(), marker, { sinceMs })
    if (!rollout) await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }
  if (!rollout) throw new Error("App-owned rollout did not become ready within 60000ms")
  const events = await readProjectedRollout(rollout)
  const session = events.find(
    (event): event is Extract<RolloutEvent, { kind: "session" }> => event.kind === "session"
  )
  if (!session?.threadId) throw new Error("App-owned rollout omitted its task id")
  try {
    return await readTask({ threadId: session.threadId, includeTurns: true })
  } catch (error) {
    if (!String(error instanceof Error ? error.message : error).includes("task not found"))
      throw error
    return {
      thread: taskAsThread(
        {
          id: String(session.threadId),
          cwd: session.cwd || request.cwd,
          preview: input.prompt,
          title: null,
          name: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        events
      ),
    }
  }
}

async function sendTask(request: ControlRequest) {
  await ensureRuntime(true)
  const id = threadId(request.threadId)
  const input = normalizedInput(request.input)
  const rollout = await findRolloutByThreadId(sessionsRoot(), id)
  if (!rollout) throw new Error(`App-owned rollout not found for task ${id}`)
  const knownTurnIds = new Set(
    (await readProjectedRollout(rollout))
      .filter(
        (event): event is Extract<RolloutEvent, { kind: "turn" }> =>
          event.kind === "turn" && event.status === "started" && Boolean(event.turnId)
      )
      .map((event) => event.turnId)
  )
  if (request.contextLabel) {
    await invokeCodexComposerContext(
      { threadId: id, label: requiredString(request.contextLabel, "contextLabel", 160) },
      { cdpPort: CDP_PORT }
    )
  }
  const nonce = randomBytes(12).toString("hex")
  const submitted = await submitCodexComposerPrompt(
    {
      threadId: id,
      prompt: input.prompt,
      filePaths: input.filePaths,
      nonce,
    },
    { cdpPort: CDP_PORT }
  )
  const deadline = Date.now() + 15_000
  let turnId: string | null | undefined = null
  while (Date.now() < deadline && !turnId) {
    const events = await readProjectedRollout(rollout)
    turnId = findNewTurnId(events, knownTurnIds)
    if (!turnId) await new Promise((resolveWait) => setTimeout(resolveWait, 200))
  }
  if (!turnId) throw new Error("App-owned turn id did not become ready within 15000ms")
  return { turn: { id: turnId }, submission: submitted.submission }
}

interface SkillEntry {
  name: string
  path: string
  enabled: boolean
}

async function skillFiles(root: string, depth = 0): Promise<SkillEntry[]> {
  if (depth > 7) return []
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const found: SkillEntry[] = []
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isFile() && entry.name === "SKILL.md") {
      const text = await readFile(path, "utf8").catch(() => "")
      const heading = text.match(/^#\s+(.+)$/m)?.[1]?.trim()
      found.push({ name: heading || basename(root), path, enabled: true })
    } else if (entry.isDirectory() && !entry.name.startsWith(".")) {
      found.push(...(await skillFiles(path, depth + 1)))
    }
  }
  return found
}

async function inventory(request: ControlRequest) {
  const cwd = requiredString(request.cwd, "cwd", 4_096)
  const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex")
  const roots = [
    join(codexHome, "skills"),
    join(codexHome, "plugins", "cache"),
    join(cwd, ".agents", "skills"),
  ]
  const skills = (await Promise.all(roots.map((root) => skillFiles(root)))).flat()
  let composerContexts: unknown = []
  if (request.threadId) {
    await ensureRuntime(false)
    const result = await listCodexComposerContexts(
      { threadId: threadId(request.threadId) },
      { cdpPort: CDP_PORT }
    )
    const contexts: unknown = result.contexts
    const items =
      typeof contexts === "object" && contexts !== null && !Array.isArray(contexts)
        ? (contexts as { items?: unknown }).items
        : undefined
    composerContexts = items ?? contexts ?? []
  }
  return {
    plugins: { composerContexts },
    skills: { data: [{ cwd, skills }] },
    mcpServers: { data: [] },
  }
}

/** Run one control operation. Throws for an unknown operation or an invalid request. */
export async function dispatch(operation: string, input: ControlRequest): Promise<unknown> {
  switch (operation) {
    case "runtime-status": {
      try {
        const runtime = await ensureRuntime(false)
        return { ready: true, mode: "normal-app-cdp-rollout-mirror", runtime }
      } catch (error) {
        return {
          ready: false,
          mode: "normal-app-cdp-rollout-mirror",
          restartSupported: process.platform === "darwin",
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }
    case "task-list":
      return listTasks(input)
    case "task-read":
      return readTask(input)
    case "task-create":
      return createTask(input)
    case "task-send":
      return sendTask(input)
    case "task-interrupt":
      await ensureRuntime(true)
      return interruptCodexTask({ threadId: threadId(input.threadId) }, { cdpPort: CDP_PORT }).then(
        (result) => ({
          threadId: result.threadId,
          interrupted: result.interruption?.interrupted === true,
          reason: result.interruption?.reason ?? null,
        })
      )
    case "task-open":
      await ensureRuntime(true)
      return openCodexTask({ threadId: threadId(input.threadId) }, { cdpPort: CDP_PORT }).then(
        (result) => ({ threadId: result.threadId, deepLink: result.threadDeepLink })
      )
    case "inventory":
      return inventory(input)
    default:
      throw new Error(`unknown Codex App control operation: ${operation}`)
  }
}

/**
 * The process entry (control-cli.mjs): `argv[0]` is the operation. Writes one
 * JSON result line and returns the exit code.
 */
export async function runControlCli(
  argv: readonly string[],
  {
    input = process.stdin,
    write = (text: string) => process.stdout.write(text),
  }: {
    input?: AsyncIterable<unknown>
    write?: (text: string) => unknown
  } = {}
): Promise<number> {
  try {
    const operation = requiredString(argv[0], "operation", 64)
    const result = await dispatch(operation, await readInput(input))
    write(`${JSON.stringify({ ok: true, result })}\n`)
    return 0
  } catch (error) {
    write(
      `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`
    )
    return 1
  }
}
