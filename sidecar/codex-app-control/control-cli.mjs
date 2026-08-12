#!/usr/bin/env node

import { randomBytes } from "node:crypto"
import { readdir, readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, join, resolve } from "node:path"

import {
  bootstrapCodexTask,
  interruptCodexTask,
  invokeCodexComposerContext,
  listCodexComposerContexts,
  openCodexTask,
  submitCodexComposerPrompt,
} from "./cdp-bootstrap.mjs"
import { ensureCodexCdpRuntime } from "./cdp-runtime.mjs"
import {
  findNewTurnId,
  findRolloutByMarker,
  findRolloutByThreadId,
  readProjectedRollout,
} from "./rollout-mirror.mjs"
import { defaultStateDir } from "./shared.mjs"
import { listCodexTasks } from "./task-index.mjs"

const CDP_PORT = 9229
const THREAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_STDIN_BYTES = 8 << 20

function requiredString(value, name, maxLength = 64 * 1024) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} is required`)
  if (value.length > maxLength) throw new Error(`${name} exceeds ${maxLength} characters`)
  return value.trim()
}

function threadId(value) {
  const normalized = requiredString(value, "threadId", 64)
  if (!THREAD_ID_PATTERN.test(normalized)) throw new Error("threadId is invalid")
  return normalized
}

async function readInput() {
  let value = ""
  for await (const chunk of process.stdin) {
    value += chunk
    if (Buffer.byteLength(value) > MAX_STDIN_BYTES) throw new Error("control request is too large")
  }
  return value.trim() ? JSON.parse(value) : {}
}

function sessionsRoot() {
  const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex")
  return join(codexHome, "sessions")
}

async function ensureRuntime(autoRestart) {
  return ensureCodexCdpRuntime({
    cdpPort: CDP_PORT,
    autoRestart,
    stateDir: defaultStateDir(),
    timeoutMs: autoRestart ? 60_000 : 2_500,
  })
}

function normalizedInput(items) {
  if (!Array.isArray(items) || items.length === 0) throw new Error("input is required")
  const prompt = []
  const filePaths = []
  for (const item of items) {
    if (!item || typeof item !== "object") throw new Error("input item is invalid")
    if (item.type === "text") prompt.push(requiredString(item.text, "input.text"))
    else if (item.type === "image" || item.type === "audio") {
      prompt.push(requiredString(item.url, `input.${item.type}.url`, 8_000))
    } else if (["localImage", "localAudio", "mention"].includes(item.type)) {
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

function taskAsThread(task, turns = []) {
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

async function listTasks(request) {
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

async function readTask(request) {
  const id = threadId(request.threadId)
  const result = await listCodexTasks({
    limit: 50,
    query: id,
    archived: "all",
    scope: "all",
  })
  const task = result.tasks.find((candidate) => candidate.id === id)
  if (!task) throw new Error(`Codex App task not found: ${id}`)
  let turns = []
  if (request.includeTurns !== false) {
    const rollout = await findRolloutByThreadId(sessionsRoot(), id)
    if (rollout) turns = await readProjectedRollout(rollout)
  }
  return { thread: taskAsThread(task, turns) }
}

async function createTask(request) {
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
  let rollout = null
  while (Date.now() < deadline && !rollout) {
    rollout = await findRolloutByMarker(sessionsRoot(), marker, { sinceMs })
    if (!rollout) await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }
  if (!rollout) throw new Error("App-owned rollout did not become ready within 60000ms")
  const events = await readProjectedRollout(rollout)
  const session = events.find((event) => event.kind === "session")
  if (!session?.threadId) throw new Error("App-owned rollout omitted its task id")
  try {
    return await readTask({ threadId: session.threadId, includeTurns: true })
  } catch (error) {
    if (!String(error?.message ?? error).includes("task not found")) throw error
    return {
      thread: taskAsThread(
        {
          id: session.threadId,
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

async function sendTask(request) {
  await ensureRuntime(true)
  const id = threadId(request.threadId)
  const input = normalizedInput(request.input)
  const rollout = await findRolloutByThreadId(sessionsRoot(), id)
  if (!rollout) throw new Error(`App-owned rollout not found for task ${id}`)
  const knownTurnIds = new Set(
    (await readProjectedRollout(rollout))
      .filter((event) => event.kind === "turn" && event.status === "started" && event.turnId)
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
  let turnId = null
  while (Date.now() < deadline && !turnId) {
    const events = await readProjectedRollout(rollout)
    turnId = findNewTurnId(events, knownTurnIds)
    if (!turnId) await new Promise((resolveWait) => setTimeout(resolveWait, 200))
  }
  if (!turnId) throw new Error("App-owned turn id did not become ready within 15000ms")
  return { turn: { id: turnId }, submission: submitted.submission }
}

async function skillFiles(root, depth = 0) {
  if (depth > 7) return []
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const found = []
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

async function inventory(request) {
  const cwd = requiredString(request.cwd, "cwd", 4_096)
  const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex")
  const roots = [
    join(codexHome, "skills"),
    join(codexHome, "plugins", "cache"),
    join(cwd, ".agents", "skills"),
  ]
  const skills = (await Promise.all(roots.map((root) => skillFiles(root)))).flat()
  let composerContexts = []
  if (request.threadId) {
    await ensureRuntime(false)
    const result = await listCodexComposerContexts(
      { threadId: threadId(request.threadId) },
      { cdpPort: CDP_PORT }
    )
    composerContexts = result.contexts?.items ?? result.contexts ?? []
  }
  return {
    plugins: { composerContexts },
    skills: { data: [{ cwd, skills }] },
    mcpServers: { data: [] },
  }
}

async function dispatch(operation, input) {
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

try {
  const operation = requiredString(process.argv[2], "operation", 64)
  const result = await dispatch(operation, await readInput())
  process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`)
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`
  )
  process.exitCode = 1
}
