#!/usr/bin/env node
/** Real PTY acceptance, isolated state, one explicitly selected local model. */
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import http from "node:http"
import { createHash, randomBytes } from "node:crypto"
import { execFileSync, spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { loadSupport, typeRendered } from "../test/cli-conversation-real.mjs"
import { createLiveStreamCompat } from "./builtin-agent-live-stream-compat.mjs"
import {
  INVENTORY_V1,
  INVENTORY_V2,
  TASKBOARD_REQUIREMENTS,
  verifyInventory,
  verifyTaskboard,
  projectEnv,
  projectSnapshot,
  researchSourcePages,
} from "./tui-project-acceptance.mjs"
import {
  completedSubagentResult,
  freshCommandResult,
  newToolNames,
  redactArtifact,
  requestContextEvidence,
  successfulStep,
  recordedReadPaths,
  toolCalls,
  hostToolResults,
  ownedProcessIds,
  renderedPaste,
  projectRecallEvidence,
  sourceCorrectionEvidence,
  completedInferenceEvidence,
  createSourceReadObserver,
  sourceFindingEvidence,
} from "./tui-live-evidence.mjs"

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const root = path.resolve(
  process.env.COGNIA_TUI_LIVE_DIR || path.join(repo, ".cache/tui-v41-2026-10-22/run-1")
)
const model = "ark-deepseek-v4.1-flash"
const phase = process.argv[2] || "core"
const projectPressure =
  phase.startsWith("project") && process.env.COGNIA_TUI_PROJECT_COMPACTION === "pressure"
const correctionRun = phase === "budget" && process.env.COGNIA_TUI_LIVE_CORRECTION === "1"
const pressureRun = phase === "pressure" || phase === "pressure-exit"
const researchWindow = Number(process.env.COGNIA_TUI_LIVE_RESEARCH_WINDOW || 32768)
assert.ok(Number.isSafeInteger(researchWindow) && researchWindow > 0)
const budgetSteps = Number(process.env.COGNIA_TUI_LIVE_BUDGET_STEPS || 2)
assert.ok(Number.isSafeInteger(budgetSteps) && budgetSteps > 0)
const budgetTimeoutMs = Number(process.env.COGNIA_TUI_LIVE_BUDGET_TIMEOUT_MS || 480000)
assert.ok(Number.isSafeInteger(budgetTimeoutMs) && budgetTimeoutMs > 0)
// DeepSeek's native adapter consumes reasoning_content; the generic OpenAI
// adapter ignores that channel and cannot observe a long reasoning-only leg.
const provider =
  phase.startsWith("project") || pressureRun || correctionRun ? "deepseek" : "tui-local"
const cliPath = path.resolve(
  process.env.COGNIA_TUI_LIVE_CLI ||
    path.join(repo, ".cache/tui-v41-2026-10-22/cli/cognia-agent.mjs")
)
const home = path.join(root, "home")
const workspace = path.join(root, "workspace")
const osHome = path.join(root, "os-home")
fs.mkdirSync(home, { recursive: true, mode: 0o700 })
fs.mkdirSync(workspace, { recursive: true })
fs.mkdirSync(osHome, { recursive: true, mode: 0o700 })
const support = await loadSupport(root)
const require = createRequire(path.join(repo, "package.json"))
const pty = require("node-pty")
const key = execFileSync(
  "rtk",
  ["proxy", "node", "/Users/bytedance/Project/aiden-llm-proxy/dist/cli.js", "key"],
  { encoding: "utf8" }
).trim()
assert.ok(key, "local proxy key must be available")
const redact = (s) => redactArtifact(s, key)
const results = []
const requests = []
let current
let fatalUpstream
let launchCount = 0
let evidenceProbe = ""
let holdAfterEvidence = false
function save() {
  const target = path.join(root, `${phase}-results.json`)
  fs.writeFileSync(
    `${target}.tmp`,
    redact(
      JSON.stringify(
        { model, phase, cliPath, compatibility: "test relay only", results, requests },
        null,
        2
      )
    ),
    { mode: 0o600 }
  )
  fs.renameSync(`${target}.tmp`, target)
}

// Observe only metadata, never persist keys, request prompts or raw response bodies.
const relay = http.createServer((req, res) => {
  const chunks = []
  req.on("data", (b) => chunks.push(b))
  req.on("end", () => {
    const body = Buffer.concat(chunks)
    let parsed
    try {
      parsed = JSON.parse(body.toString())
    } catch {}
    const row = {
      at: Date.now(),
      path: req.url,
      model: parsed?.model,
      tools: parsed?.tools?.length,
      inputHash: createHash("sha256").update(body).digest("hex"),
      outputLimit: parsed?.max_tokens ?? parsed?.max_completion_tokens,
      reasoningEffort: parsed?.reasoning_effort,
      thinkingType: parsed?.thinking?.type,
      repairs: {},
      toolNames: [],
      ...requestContextEvidence(parsed?.messages),
      ...(phase === "bridge"
        ? { hostResults: hostToolResults(parsed?.messages, evidenceProbe) }
        : {}),
      priorFactPresent: Boolean(evidenceProbe && body.includes(Buffer.from(evidenceProbe))),
    }
    requests.push(row)
    save()
    if (parsed?.model && parsed.model !== model) {
      row.error = "rejected unexpected model"
      res.writeHead(400).end("unexpected model")
      save()
      return
    }
    const upstream = http.request(
      {
        hostname: "127.0.0.1",
        port: 8787,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: "127.0.0.1:8787" },
      },
      (response) => {
        row.status = response.statusCode
        response.on("data", (b) => {
          row.firstChunkAt ??= Date.now()
          row.lastChunkAt = Date.now()
          row.dataChunks = (row.dataChunks || 0) + 1
          row.bytes = (row.bytes || 0) + b.length
          if (!row.savedProgressAt || Date.now() - row.savedProgressAt > 1000) {
            row.savedProgressAt = Date.now()
            save()
          }
        })
        if ([403, 429, 502].includes(row.status)) fatalUpstream = `upstream HTTP ${row.status}`
        const headers = { ...response.headers }
        delete headers["content-length"]
        res.writeHead(response.statusCode, headers)
        if (holdAfterEvidence && row.priorFactPresent && row.status === 200) {
          // Controlled timing only: a genuine upstream response has started
          // after a completed source read, while the real agent remains active.
          row.heldAt = Date.now()
          response.pause()
          res.flushHeaders()
          save()
          return
        }
        const compat = createLiveStreamCompat((kind) => {
          row.repairs[kind] = (row.repairs[kind] || 0) + 1
        })
        const sourceReadObserver = createSourceReadObserver()
        let pending = ""
        compat.on("data", (b) => {
          pending += b.toString()
          let end
          while ((end = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, end).trimEnd()
            pending = pending.slice(end + 1)
            if (line === "data: [DONE]") row.done = true
            if (!line.startsWith("data: {")) continue
            try {
              const event = JSON.parse(line.slice(6))
              if (event.error) row.streamError = true
              if (event.usage) row.usage = event.usage
              row.streamEvents = (row.streamEvents || 0) + 1
              for (const c of event.choices || []) {
                row.reasoningChars =
                  (row.reasoningChars || 0) + (c.delta?.reasoning_content?.length || 0)
                row.visibleChars = (row.visibleChars || 0) + (c.delta?.content?.length || 0)
                if (Object.hasOwn(c, "finish_reason")) {
                  row.finishFields = (row.finishFields || 0) + 1
                  if (c.finish_reason !== null) row.rawFinish = c.finish_reason
                }
                if (c.finish_reason) row.finish = c.finish_reason
                for (const t of c.delta?.tool_calls || []) {
                  sourceReadObserver.observe(t)
                  if (t.function?.name) row.toolNames.push(t.function.name)
                  row.toolArgumentChars =
                    (row.toolArgumentChars || 0) + (t.function?.arguments?.length || 0)
                }
              }
            } catch {
              row.parseFailures = (row.parseFailures || 0) + 1
            }
          }
        })
        response.pipe(compat).pipe(res)
        response.on("end", () => {
          row.responseReads = sourceReadObserver.reads()
          row.completed = true
          row.seconds = (Date.now() - row.at) / 1000
          save()
        })
        response.on("error", (error) => {
          row.error = redact(error.message)
          res.destroy()
          save()
        })
      }
    )
    upstream.on("error", (error) => {
      row.error = redact(error.message)
      if (!row.cancelled) fatalUpstream = row.error
      if (!res.headersSent) res.writeHead(502)
      res.end()
      save()
    })
    res.on("close", () => {
      if (!row.completed) {
        row.cancelled = true
        upstream.destroy()
        save()
      }
    })
    upstream.end(body)
  })
})
await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve))
const configFile = path.join(home, "config.json")
const existing = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, "utf8")) : {}
fs.writeFileSync(
  configFile,
  JSON.stringify(
    support.cliConfigFileSchema.parse({
      ...existing,
      provider,
      model,
      agentBackend: "builtin",
      locale: "en",
      externalSkills: false,
      permissionMode: phase === "pressure-exit" ? "plan" : "default",
      layout: "fullscreen",
      ...(phase === "bridge" ? { pluginTools: true, aiSdkMaxSteps: 128 } : {}),
      ...(pressureRun
        ? { aiSdkMaxSteps: 128 }
        : phase === "budget" || phase === "shutdown"
          ? { aiSdkMaxSteps: budgetSteps }
          : {}),
      providers: {
        [provider]: {
          protocol: "openai",
          baseURL: `http://127.0.0.1:${relay.address().port}/v1`,
          model,
          contextWindow: pressureRun
            ? researchWindow
            : projectPressure || correctionRun
              ? 32768
              : 936000,
        },
      },
    }),
    null,
    2
  ),
  { mode: 0o600 }
)

function rows() {
  const dir = path.join(home, "sessions")
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((file) => {
      try {
        return fs
          .readFileSync(path.join(dir, file), "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => ({ ...JSON.parse(l), file }))
      } catch {
        return []
      }
    })
}
async function launch(extra = []) {
  const name = `${phase}-${++launchCount}`
  const screen = new support.TerminalScreen({ columns: 240, rows: 48 })
  const env = Object.fromEntries(
    ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "SHELL", "LANG"]
      .filter((k) => process.env[k])
      .map((k) => [k, process.env[k]])
  )
  Object.assign(env, {
    HOME: osHome,
    TERM: "xterm-256color",
    NO_COLOR: "1",
    COGNIA_HOME: home,
    COGNIA_LOCALE: "en",
    COGNIA_EXTERNAL_SKILLS: "0",
    COGNIA_PROVIDER: provider,
    COGNIA_API_KEY: key,
    COGNIA_SANDBOX_EXEC: path.join(repo, "cli/dist/cognia-sandbox-exec"),
    COGNIA_EXTERNAL_AGENT_LAUNCHER: path.join(repo, "cli/dist/cognia-external-agent-launcher"),
    ...(process.env.COGNIA_TUI_LIVE_PRELOAD
      ? { NODE_OPTIONS: `--require=${path.resolve(process.env.COGNIA_TUI_LIVE_PRELOAD)}` }
      : {}),
  })
  const terminal = pty.spawn(
    process.execPath,
    [cliPath, "chat", "--backend", "builtin", "--cwd", workspace, ...extra],
    { name: "xterm-256color", cols: 240, rows: 48, cwd: workspace, env }
  )
  const s = { name, terminal, screen, revision: 0, exited: false, raw: "", approvals: 0 }
  current = s
  terminal.onData((chunk) => {
    s.raw += redact(chunk)
    screen.write(chunk)
    s.revision++
    fs.writeFileSync(path.join(root, "live.screen.txt"), redact(screen.text()), { mode: 0o600 })
  })
  terminal.onExit((e) => {
    s.exited = true
    s.exitedAt = Date.now()
    s.exitCode = e.exitCode
  })
  s.snapshot = (label) => {
    fs.writeFileSync(path.join(root, `${name}-${label}.screen.txt`), redact(screen.text()), {
      mode: 0o600,
    })
    fs.writeFileSync(path.join(root, `${name}.pty.log`), redact(s.raw), { mode: 0o600 })
  }
  s.idle = () =>
    screen.flatText().includes("Ask, run") && !screen.flatText().includes("esc to interrupt")
  s.wait = async (check, label, timeout = 20000, approve = false, cleanup = false) => {
    const end = Date.now() + timeout
    let decided
    let decidedAt = 0
    while (!check()) {
      if (fatalUpstream && !cleanup) throw Error(fatalUpstream)
      if (s.exited || Date.now() > end) {
        s.snapshot("timeout")
        throw Error(`${label}: ${s.exited ? `exit ${s.exitCode}` : "timeout"}`)
      }
      const approval =
        screen.flatText().includes("Allow once") && screen.flatText().includes("Deny")
      if (!approval) decided = undefined
      const approvalIdentity = screen.flatText().split("Allow once")[0]
      if (
        approve &&
        approval &&
        (decided !== approvalIdentity || (phase === "project" && Date.now() - decidedAt > 1000))
      ) {
        s.snapshot(`approval-${s.approvals}`)
        decided = approvalIdentity
        decidedAt = Date.now()
        s.approvals++
        terminal.write("\r")
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  s.send = async (text, { active = false } = {}) => {
    if (!active) await s.wait(s.idle, "idle before input")
    if (text.length <= 180) {
      await typeRendered(terminal, screen, s.wait, text, () => s.revision)
      return
    }
    const before = s.revision
    terminal.write(`\u001b[200~${text}\u001b[201~`)
    await s.wait(
      () => s.revision > before && renderedPaste(screen.text(), text),
      "long pasted composer text"
    )
    terminal.write("\r")
  }
  await s.wait(() => /Do you trust|Ask, run/.test(screen.flatText()), "trust or composer", 45000)
  if (screen.flatText().includes("Do you trust")) {
    // The first painted frame may precede Ink's input subscription. Confirm a
    // rendered selection change before sending the trust decision.
    for (const [key, selected] of [
      ["\u001b[B", "❯ Choose another folder"],
      ["\u001b[A", "❯ Yes, proceed"],
    ]) {
      const end = Date.now() + 5000
      while (!screen.flatText().includes(selected)) {
        assert.ok(Date.now() < end, "trust selector must acknowledge real input")
        terminal.write(key)
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
    terminal.write("\r")
  }
  await s.wait(s.idle, "composer startup", 45000)
  if (phase === "budget" || phase === "resume-exit") {
    // A restored transcript can paint before Ink subscribes to input. Confirm
    // an editable draft before sending a one-shot paste; never submit the probe.
    const readyDeadline = Date.now() + 5000
    const probe = "input-ready"
    const composer = () => screen.text().slice(screen.text().lastIndexOf("╭"))
    while (!renderedPaste(composer(), probe)) {
      assert.ok(Date.now() < readyDeadline, "composer must acknowledge real input")
      terminal.write("\u007f".repeat(probe.length))
      terminal.write(probe)
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const beforeClear = s.revision
    const clearDeadline = Date.now() + 5000
    while (!s.idle()) {
      assert.ok(Date.now() < clearDeadline, "composer must clear the readiness probe")
      terminal.write("\u007f")
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    await s.wait(
      () => s.revision > beforeClear && !renderedPaste(composer(), probe) && s.idle(),
      "composer readiness probe cleared"
    )
  }
  s.snapshot("startup")
  return s
}
async function close() {
  if (!current) return
  const s = current
  if (!s.exited) s.terminal.kill("SIGINT")
  try {
    await s.wait(() => s.exited, "terminal shutdown", 20000, false, true)
  } catch (error) {
    s.terminal.kill("SIGKILL")
    throw error
  }
  s.snapshot("closed")
  assert.equal(s.screen.altScreen, false)
  assert.equal(s.screen.cursorVisible, true)
  assert.deepEqual([...s.screen.mouseModes], [])
  return { exitCode: s.exitCode, restored: true }
}
async function dismissPlanReview() {
  await current.wait(
    () => /^Review plan\b/m.test(current.screen.flatText()),
    "completed Plan review before dismissal"
  )
  current.terminal.write("\u001b")
  await current.wait(
    () => !/^Review plan\b/m.test(current.screen.flatText()) && current.idle(),
    "plan review dismissed without implementation"
  )
}
async function normalExit({ active = false, packet = false } = {}) {
  const owned = ownedProcessIds(
    execFileSync("ps", ["-axo", "pid,ppid"], { encoding: "utf8" }),
    current.terminal.pid
  )
  if (packet) current.terminal.write("/exit\r")
  else await current.send("/exit", { active })
  const submittedAt = Date.now()
  const maxMs = Number(process.env.COGNIA_TUI_LIVE_EXIT_MAX_MS || 30000)
  assert.ok(Number.isFinite(maxMs) && maxMs > 0, "exit deadline must be positive")
  await current.wait(() => current.exited, "normal /exit", maxMs)
  const submitToExitMs = current.exitedAt - submittedAt
  assert.equal(current.exitCode, 0)
  assert.equal(current.screen.altScreen, false)
  assert.equal(current.screen.cursorVisible, true)
  assert.deepEqual([...current.screen.mouseModes], [])
  assert.ok(submitToExitMs <= maxMs, "normal exit exceeded its acceptance deadline")
  assert.equal(fs.existsSync(path.join(home, "db.json.lock")), false, "store lock released")
  const end = Date.now() + 2000
  let alive
  do {
    alive = owned.filter((pid) => {
      try {
        process.kill(pid, 0)
        return true
      } catch (error) {
        if (error.code === "ESRCH") return false
        throw error
      }
    })
    if (alive.length) await new Promise((resolve) => setTimeout(resolve, 25))
  } while (alive.length && Date.now() < end)
  assert.deepEqual(alive, [], "TUI and its owned descendants must all stop")
  return {
    exitCode: current.exitCode,
    restored: true,
    submitToExitMs,
    ownedProcessesStopped: owned.length,
  }
}
async function step(name, fn, dependencies = []) {
  const selectedSteps = process.env.COGNIA_TUI_LIVE_STEPS?.split(",")
  if (
    selectedSteps &&
    !name.startsWith("startup") &&
    name !== "final-terminal-cleanup" &&
    !selectedSteps.includes(name)
  )
    return
  const failedDependency = dependencies.find(
    (dependency) => !results.some((r) => r.name === dependency && r.status === "passed")
  )
  if (failedDependency) {
    results.push({ name, status: "blocked", error: `requires ${failedDependency}` })
    save()
    console.log(redact(JSON.stringify(results.at(-1))))
    return
  }
  if (fatalUpstream && name !== "final-terminal-cleanup") {
    results.push({ name, status: "blocked", error: fatalUpstream })
    save()
    return
  }
  const at = Date.now()
  try {
    results.push(successfulStep(name, await fn(), (Date.now() - at) / 1000))
  } catch (error) {
    current?.snapshot(`failed-${name}`)
    results.push({
      name,
      status: "failed",
      error: redact(error.message),
      seconds: (Date.now() - at) / 1000,
    })
  }
  save()
  console.log(redact(JSON.stringify(results.at(-1))))
}
function validatePairing(messages) {
  const pending = new Set()
  for (const m of messages || [])
    for (const c of Array.isArray(m.content) ? m.content : []) {
      if (c.type === "tool-call") pending.add(c.toolCallId)
      if (c.type === "tool-result")
        assert.ok(pending.delete(c.toolCallId), `orphan tool result ${c.toolName}`)
    }
  assert.equal(pending.size, 0, "saved tool calls must all have results")
}
async function turn(
  prompt,
  expected,
  { approve = false, timeout = 240000, confirmation = false } = {}
) {
  const at = Date.now()
  const previousIds = new Set(
    rows()
      .filter((r) => r.role === "assistant")
      .flatMap((r) => toolCalls(r.meta?.runtimeHistory?.messages))
      .map((c) => c.toolCallId)
  )
  await current.send(prompt)
  let answer
  await current.wait(
    () => {
      if (phase.startsWith("project")) {
        const error = current.screen
          .flatText()
          .match(/✗\s*session\s+\S+[\s\S]{0,100}?stream\s+idle\s+for\s+\d+ms/)
        if (error) throw Error(error[0])
      }
      const fresh = rows()
        .filter((r) => r.role === "assistant" && r.ts >= at)
        .sort((a, b) => b.ts - a.ts)[0]
      if (!fresh) return false
      answer = fresh
      return (
        current.idle() ||
        (confirmation && current.screen.flatText().includes("Apply workflow proposal?"))
      )
    },
    "persisted completed assistant and idle UI",
    timeout,
    approve
  )
  if (expected instanceof RegExp) assert.match(answer.content, expected)
  else if (expected !== undefined) assert.equal(answer.content.trim(), expected)
  assert.ok(
    rows().some((r) => r.role === "user" && r.ts >= at && r.content === prompt),
    "the complete submitted prompt must be persisted"
  )
  validatePairing(answer.meta?.runtimeHistory?.messages)
  const toolNames = newToolNames(answer.meta?.runtimeHistory?.messages, previousIds)
  current.snapshot(`turn-${at}`)
  return { answer: answer.content, session: answer.file, toolNames, approvals: current.approvals }
}
async function panel(command, pattern) {
  await close()
  await launch(["--continue"])
  const before = current.revision
  await current.send(command)
  await current.wait(
    () =>
      freshCommandResult({
        text: current.screen.flatText(),
        revision: current.revision,
        before,
        command,
        pattern,
      }),
    command,
    20000
  )
  current.snapshot(command.replace(/[^a-z0-9]/gi, "-"))
  return { command, visible: true }
}

function researchFixture(count) {
  const dir = path.join(workspace, "research")
  fs.mkdirSync(dir, { recursive: true })
  const names = Array.from({ length: count }, () => `page-${randomBytes(5).toString("hex")}.ts`)
  const facts = names.map((_, i) => `SOURCE_FACT_${i}_${randomBytes(4).toString("hex")}`)
  const sharedFixture = process.env.COGNIA_TUI_LIVE_RESEARCH_FIXTURE
  const shared = sharedFixture ? JSON.parse(fs.readFileSync(sharedFixture, "utf8")) : null
  if (shared) assert.equal(shared.length, count, "paired groups require the exact same corpus")
  const pages = shared ? null : researchSourcePages(repo, count)
  const manifest =
    shared ??
    names.map((name, i) => {
      const { source, start, code, codeHash, lineCount } = pages[i]
      const next = i + 1 < count ? `research/${names[i + 1]}` : "END_OF_RESEARCH"
      fs.writeFileSync(
        path.join(dir, name),
        `// Source copy: ${source}:${start}\n${code}\n// Evidence: ${facts[i]}\n// Next: ${next}\n`
      )
      return { file: `research/${name}`, source, start, fact: facts[i], next, codeHash, lineCount }
    })
  if (shared)
    for (const page of manifest) {
      fs.copyFileSync(
        path.join(path.dirname(sharedFixture), "workspace", page.file),
        path.join(workspace, page.file)
      )
    }
  if (shared) facts.splice(0, facts.length, ...shared.map((page) => page.fact))
  fs.writeFileSync(path.join(root, `${phase}-fixture.json`), JSON.stringify(manifest, null, 2))
  evidenceProbe = facts[0]
  return {
    manifest,
    facts,
    task: `Investigate the execution, budget, cancellation and compaction behavior in this linked real-source corpus. During Explore start at ${manifest[0].file}, read the ENTIRE file using read limit=400, then follow only its Next footer until END_OF_RESEARCH. That marker ends the corpus; it is not a path and must never be opened or checked. These pages are read-only copies of real checkout code. Source-copy paths are provenance labels in the original repository, not files present in this isolated workspace. Do not search for or open those original paths, and do not treat their absence as a blocker; cite the copied page and optionally its provenance label. Use read only, no search, glob, ls, tests or edits. Each footer reveals the next path; never guess one. An Evidence code is the literal SOURCE_FACT_... marker after // Evidence:, never a page filename or ordinal. Retain every Evidence code verbatim with one source-backed behavior and original path:line. Maintain established findings separately from the next unread path. Never reread a completed page after compaction or resume. Finish Explore with a <source-findings> JSON array </source-findings>, with exactly one row per page: {"code":"literal Evidence code","behavior":"one concise established source-backed behavior","source":"full copied page path:line and full original provenance path:line"}. This array is the concise behavior matrix, not just a list of codes. Preserve behavior text throughout compaction in host-owned facts. During Plan reuse the completed Explore report and its Evidence codes; do not repeat its reads. Propose a minimal implementation and regression-test plan and include the complete <source-findings> array in the evidence appendix, preserving every behavior and both source citations. Limit the final plan to at most eight concrete steps plus the concise appendix; no long essay. Do not implement changes.`,
  }
}
function uniqueResearchReads(inference) {
  return [
    ...new Map(
      inference
        .flatMap((r) => [...(r.sourceReads || []), ...(r.responseReads || [])])
        .filter((r) => r.path?.includes("research/page-"))
        .map((r) => [r.id, r])
    ).values(),
  ]
}
function savedPlans() {
  const dir = path.join(home, "plans")
  return fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".md"))
        .map((f) => ({
          file: f,
          modified: fs.statSync(path.join(dir, f)).mtimeMs,
          text: fs.readFileSync(path.join(dir, f), "utf8"),
        }))
    : []
}
function incompleteRecords() {
  const dir = path.join(home, "db.json.tables")
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => /--backgroundTasks\.json$/.test(f))
    .flatMap((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")))
}

try {
  if (phase === "resume-exit") {
    const before = projectSnapshot(workspace)
    await step("startup-retained-profile", async () => {
      await launch(["--continue"])
      return { resumed: true, inferenceRequired: false }
    })
    await step("normal-exit-retained-profile", normalExit, ["startup-retained-profile"])
    assert.equal(requests.filter((r) => r.model).length, 0)
    assert.deepEqual(projectSnapshot(workspace), before)
  } else if (phase === "pressure-exit") {
    const before = projectSnapshot(workspace)
    const saved = savedPlans()[0]
    assert.ok(saved, "restore the completed pressure plan instead of repeating research")
    await step("startup-restored-pressure-plan", async () => {
      await launch(["--continue"])
      return {
        savedPlan: saved.file,
        sourcePages: fs.readdirSync(path.join(workspace, "research")).length,
      }
    })
    await step(
      "dismiss-restored-plan-review",
      async () => {
        await current.send(
          `Return a brief read-only plan for retaining the completed research saved in ${saved.file}. Use a heading and exactly two numbered steps: retain the existing research artifacts, then stop. No tools, research, edits, tests or implementation.`
        )
        await current.wait(
          () => /^Review plan\b/m.test(current.screen.flatText()),
          "plan review focus",
          120000
        )
        current.snapshot("restored-plan-review")
        // Opening review is a tool result, not completion of the model turn.
        // Dismiss it and await the idle UI before validating transport cleanup.
        await dismissPlanReview()
        const inference = requests.filter((r) => r.model)
        completedInferenceEvidence(inference)
        assert.ok(
          inference.every((r) => r.toolNames.every((name) => name === "exit_plan_mode")),
          "focus recovery must not repeat research"
        )
        assert.deepEqual(projectSnapshot(workspace), before)
        return {
          requests: inference.length,
          sourceReads: 0,
          reviewDismissed: true,
          workspaceUnchanged: true,
        }
      },
      ["startup-restored-pressure-plan"]
    )
    await step("normal-exit-after-pressure-review", normalExit, ["dismiss-restored-plan-review"])
  } else if (phase === "project-recall") {
    const before = projectSnapshot(workspace)
    await step("startup-project-recall", async () => {
      await launch(["--continue"])
      return { existingRealProject: true, pressure: projectPressure }
    })
    await step(
      "clarify-current-project-scope",
      async () => {
        const result = await turn(
          "The entire current requirements.md, including the Version 2 follow-up appended by me, is the authorized user scope. Preserve already verified completed work; only genuinely unresolved original requirements belong in pending. Do not edit files or use tools. Acknowledge this scope clarification."
        )
        assert.equal(result.toolNames.length, 0)
        return { currentUserScopeExplicit: true }
      },
      ["startup-project-recall"]
    )
    await step(
      "compact-and-recall-existing-project",
      async () => {
        const checked = spawnSync("rtk", ["proxy", "node", "--test"], {
          cwd: workspace,
          env: projectEnv(root),
          encoding: "utf8",
          timeout: 60000,
        })
        const output = `${checked.stdout || ""}${checked.stderr || ""}`
        fs.writeFileSync(path.join(root, "restored-project-tests.log"), redact(output))
        assert.ifError(checked.error)
        assert.equal(checked.status, 0, output)
        const tests = Number(output.match(/(?:#|ℹ)\s*tests\s+(\d+)/)?.[1])
        assert.ok(tests > 0)
        await current.send(
          "/compact Preserve the actual project state, source references, user constraints, verified results and unresolved original requirements."
        )
        await current.wait(
          () =>
            /Context compacted|Compaction failed|Could not compact/.test(current.screen.flatText()),
          "restored project compaction",
          900000
        )
        assert.match(current.screen.flatText(), /Context compacted/)
        const result = await turn(
          "Without tools, recall the completed project evidence as JSON. Fields: entry (actual source entry point string), tests (last node --test test count), completed (booleans named csvImport, atomicPersistence and idempotentImport), pending (array of unresolved original requirements). Use false or null for unverified claims. Do not invent success or repeat implementation or research."
        )
        projectRecallEvidence(result.answer, tests)
        assert.equal(result.toolNames.length, 0)
        const verified = verifyInventory(workspace, root, { v2: true })
        assert.deepEqual(
          projectSnapshot(workspace),
          before,
          "compaction and recall preserve project source and protected files"
        )
        return {
          projectTests: tests,
          ...verified,
          compacted: true,
          completedProgressRecalled: true,
          noNewTools: true,
        }
      },
      ["clarify-current-project-scope"]
    )
    await step("normal-exit-after-project-recall", normalExit, [
      "compact-and-recall-existing-project",
    ])
  } else if (phase === "project") {
    const project = process.env.COGNIA_TUI_PROJECT || "inventory"
    const resumeProject = process.env.COGNIA_TUI_PROJECT_RESUME === "1"
    assert.ok(["inventory", "taskboard"].includes(project), "explicit supported project")
    const requirementFile = path.join(workspace, "requirements.md")
    const noteFile = path.join(workspace, "customer-note.txt")
    let expectedRequirements = project === "inventory" ? INVENTORY_V1 : TASKBOARD_REQUIREMENTS
    const note = resumeProject
      ? fs.readFileSync(noteFile, "utf8")
      : `Customer-owned note. Preserve these bytes: ${randomBytes(12).toString("hex")}\n`
    if (!resumeProject) {
      fs.writeFileSync(
        requirementFile,
        project === "inventory" ? INVENTORY_V1 : TASKBOARD_REQUIREMENTS
      )
      fs.writeFileSync(noteFile, note)
    }
    if (!fs.existsSync(path.join(workspace, ".git"))) {
      execFileSync("rtk", ["proxy", "git", "init", "-q"], { cwd: workspace })
      execFileSync("rtk", ["proxy", "git", "add", "requirements.md", "customer-note.txt"], {
        cwd: workspace,
      })
      execFileSync(
        "rtk",
        [
          "proxy",
          "git",
          "-c",
          "user.name=Acceptance",
          "-c",
          "user.email=acceptance@example.invalid",
          "commit",
          "-qm",
          "fixture requirements",
        ],
        { cwd: workspace }
      )
    }
    const preserve = () => {
      assert.equal(fs.readFileSync(noteFile, "utf8"), note, "customer file unchanged")
      assert.equal(
        fs.readFileSync(requirementFile, "utf8"),
        expectedRequirements,
        "requirements unchanged"
      )
    }
    const ownTests = (stage) => {
      const pkg = JSON.parse(fs.readFileSync(path.join(workspace, "package.json"), "utf8"))
      assert.match(pkg.scripts?.test || "", /node\s+--test/)
      const r = spawnSync("rtk", ["proxy", "node", "--test"], {
        cwd: workspace,
        env: projectEnv(root),
        encoding: "utf8",
        timeout: 60_000,
      })
      const output = `${r.stdout || ""}${r.stderr || ""}`
      fs.writeFileSync(
        path.join(root, `${stage}-project-tests-${Date.now()}.log`),
        redact(output),
        { mode: 0o600 }
      )
      assert.ifError(r.error)
      assert.equal(r.status, 0, output)
      assert.match(output, /(?:#|ℹ)\s*tests\s+[1-9]\d*/)
      return { projectTests: Number(output.match(/(?:#|ℹ)\s*tests\s+(\d+)/)?.[1]) }
    }
    const implement = async (prompt, verify, stage) => {
      const attempts = []
      let next = prompt
      for (let attempt = 1; attempt <= 3; attempt++) {
        const at = Date.now()
        const result = await turn(next, undefined, { approve: true, timeout: 900000 })
        preserve()
        try {
          const checked = await verify()
          attempts.push({
            attempt,
            status: "passed",
            seconds: (Date.now() - at) / 1000,
            tools: result.toolNames,
          })
          fs.writeFileSync(
            path.join(root, `${stage}-attempts.json`),
            JSON.stringify(attempts, null, 2)
          )
          return {
            ...checked,
            attempts: attempt,
            toolNames: result.toolNames,
            approvals: result.approvals,
          }
        } catch (error) {
          const failure = redact(error.message).slice(0, 12000)
          attempts.push({
            attempt,
            status: "failed",
            error: failure,
            seconds: (Date.now() - at) / 1000,
          })
          fs.writeFileSync(
            path.join(root, `${stage}-attempts.json`),
            JSON.stringify(attempts, null, 2)
          )
          if (attempt === 3) throw error
          next = `Independent acceptance failed for the real project. Read requirements.md and fix the implementation; keep customer-note.txt and requirements.md unchanged. Do not weaken tests or remove required features. Run finite node tests only, no typecheck, Tauri, installs or persistent servers. Failure:\n${failure}`
        }
      }
    }
    await step("startup-project", async () => {
      await launch(
        resumeProject && process.env.COGNIA_TUI_PROJECT_SESSION_RESUME !== "0" ? ["--continue"] : []
      )
      return { project, workspace }
    })
    await step(
      "shell-user-environment",
      async () => {
        const file = path.join(workspace, "shell-environment.json")
        assert.ok(!fs.existsSync(file), "fresh shell evidence")
        await current.send(
          "!node -e \"require('fs').writeFileSync('shell-environment.json',JSON.stringify({mode:process.env.NODE_ENV??null}));console.log('SHELL_ENV_DONE')\""
        )
        await current.wait(
          () => fs.existsSync(file) && current.idle(),
          "real user shell completion"
        )
        assert.equal(
          JSON.parse(fs.readFileSync(file, "utf8")).mode,
          null,
          "internal production mode must not leak to user shell"
        )
        return { mode: null, realUserCommand: true }
      },
      ["startup-project"]
    )
    await step(
      "implement-real-project",
      () =>
        implement(
          process.env.COGNIA_TUI_PROJECT_TASK ||
            "Read requirements.md and implement the complete runnable project described there. Create real source, tests and README, then run finite tests and fix failures before finishing. Work only in this workspace. Keep requirements.md and customer-note.txt byte-for-byte unchanged. Do not run typecheck, Tauri, package installs or a persistent server. Use only this configured model. Finish with the actual test result and run commands.",
          async () => {
            assert.equal(
              fs.readFileSync(requirementFile, "utf8"),
              project === "inventory" ? INVENTORY_V1 : TASKBOARD_REQUIREMENTS
            )
            const tested = ownTests("v1")
            const verified =
              project === "inventory"
                ? verifyInventory(workspace, root)
                : await verifyTaskboard(workspace, root, redact)
            return { ...tested, ...verified }
          },
          "v1"
        ),
      ["startup-project"]
    )
    await step("exit-after-project-v1", normalExit, ["implement-real-project"])
    await step(
      "restart-project-context",
      async () => {
        await launch(["--continue"])
        const r = await turn(
          "Without tools, name the project just implemented, its source entry point and one persistence guarantee. Use your restored conversation; do not start a new project."
        )
        assert.match(
          r.answer,
          project === "inventory" ? /inventory|warehouse|ledger/i : /task.?board/i
        )
        assert.match(r.answer, project === "inventory" ? /cli\.mjs/ : /server\.mjs/)
        assert.equal(r.toolNames.length, 0)
        return { restored: true, noNewTools: true }
      },
      ["exit-after-project-v1"]
    )
    if (project === "inventory") {
      await step(
        "remember-project-constraints",
        async () => {
          evidenceProbe = `PROJECT_CONSTRAINT_${randomBytes(6).toString("hex")}`
          await turn(
            `For this project retain these user constraints: no installs, preserve customer-note.txt, keep independent acceptance, and retain ${evidenceProbe}. Reply only ${evidenceProbe}.`,
            evidenceProbe
          )
          return { earlierUserInstructions: true }
        },
        ["restart-project-context"]
      )
      await step(
        "explore-plan-real-change",
        async () => {
          const at = Date.now()
          fs.appendFileSync(requirementFile, INVENTORY_V2)
          expectedRequirements += INVENTORY_V2
          const before = projectSnapshot(workspace)
          await current.send(
            "/plan explore Implement Version 2 transactional CSV import in requirements.md. Explore the existing actual inventory project and tests, identify reusable CSV and persistence code, then have Plan reuse those findings to propose a small implementation and regression plan. Do not edit files, install packages or run typecheck/Tauri."
          )
          await current.wait(
            () => /Review plan|Plan exploration failed/.test(current.screen.flatText()),
            "actual project plan review",
            360000
          )
          assert.match(current.screen.flatText(), /Review plan/)
          assert.deepEqual(
            projectSnapshot(workspace),
            before,
            "planning must leave project files unchanged"
          )
          const childRequests = requests.filter(
            (r) => r.at >= at && ["Explore", "Plan"].includes(r.agentRole)
          )
          assert.ok(
            childRequests.some((r) => r.agentRole === "Explore" && r.priorFactPresent),
            "Explore inherits earlier user constraints"
          )
          assert.ok(
            childRequests.some((r) => r.agentRole === "Plan" && r.priorFactPresent),
            "Plan inherits earlier user constraints"
          )
          preserve()
          current.snapshot("real-project-plan-review")
          return { planReview: true, unchangedProject: true, savedPlans: savedPlans().length }
        },
        ["restart-project-context"]
      )
      await step(
        "approve-and-implement-v2",
        async () => {
          const at = Date.now()
          current.terminal.write("\r")
          await current.wait(
            () => current.screen.flatText().includes("Enter select"),
            "plan actions"
          )
          current.terminal.write("\u001b[B")
          await current.wait(
            () => current.screen.flatText().includes("2/5"),
            "confirm-edit plan choice"
          )
          current.snapshot("real-project-plan-confirm")
          current.terminal.write("\r")
          await current.wait(
            () => rows().some((r) => r.role === "assistant" && r.ts >= at) && current.idle(),
            "approved plan implemented",
            900000,
            true
          )
          preserve()
          return await implement(
            "Verify the approved Version 2 change against requirements.md, fix any remaining defect and run node --test. Do not modify the requirements or customer note. Do not run typecheck, Tauri or installs.",
            () => ({ ...ownTests("v2"), ...verifyInventory(workspace, root, { v2: true }) }),
            "v2"
          )
        },
        ["explore-plan-real-change"]
      )
      await step(
        "compact-real-project",
        async () => {
          const at = Date.now()
          await current.send(
            "/compact Preserve the actual project state, source references, user constraints, verified results and unresolved requirements. Distinguish established facts from open questions."
          )
          await current.wait(
            () =>
              /Context compacted|Compaction failed|Could not compact|Compaction unavailable|Nothing to compact yet/.test(
                current.screen.flatText()
              ),
            "project compaction",
            120000
          )
          assert.match(current.screen.flatText(), /Context compacted/)
          const tests = results.find((r) => r.name === "approve-and-implement-v2").projectTests
          const result = await turn(
            "Without tools, recall the completed project evidence as JSON. Fields: entry (actual source entry point string), tests (last node --test test count), completed (booleans named csvImport, atomicPersistence and idempotentImport), pending (array of unresolved original requirements). Use false or null for unverified claims. Do not invent success, repeat implementation or research."
          )
          projectRecallEvidence(result.answer, tests)
          assert.equal(result.toolNames.length, 0)
          verifyInventory(workspace, root, { v2: true })
          if (projectPressure)
            assert.ok(
              requests.some((r) => r.hasSummary && r.at < at),
              "pressure project publishes a summary before final manual recall"
            )
          return { compacted: true, completedProgressRecalled: true }
        },
        ["approve-and-implement-v2"]
      )
    }
    await step(
      "project-session-export",
      async () => {
        const before = new Map(
          fs
            .readdirSync(workspace)
            .filter((f) => /^cognia-export-.*\.json$/.test(f))
            .map((f) => [f, fs.statSync(path.join(workspace, f)).mtimeMs])
        )
        await current.send("/export json")
        let target
        await current.wait(
          () =>
            (target = fs
              .readdirSync(workspace)
              .find(
                (f) =>
                  /^cognia-export-.*\.json$/.test(f) &&
                  (!before.has(f) || fs.statSync(path.join(workspace, f)).mtimeMs > before.get(f))
              )),
          "project export"
        )
        const saved = JSON.parse(fs.readFileSync(path.join(workspace, target), "utf8"))
        assert.ok(JSON.stringify(saved).includes("requirements.md"))
        preserve()
        return { export: target }
      },
      ["restart-project-context"]
    )
    await step("normal-project-exit", normalExit, ["project-session-export"])
  } else if (phase === "exit-active") {
    const actor = process.env.COGNIA_TUI_EXIT_ACTOR || "main"
    const state = process.env.COGNIA_TUI_EXIT_STATE || "running"
    const fixture = researchFixture(6)
    let owner
    await step("startup-exit-active", async () => {
      await launch()
      const r = await turn("Without tools, calculate 2 + 3. Reply only 5.", "5")
      owner = r.session.replace(/\.jsonl$/, "")
      return { actor, state, owner }
    })
    let interrupted
    const writeToken = `WRITE_${randomBytes(6).toString("hex")}`
    if (state === "writing") {
      fs.writeFileSync(
        path.join(workspace, "write-stage.cjs"),
        `const fs=require('node:fs');const file='progress-output.txt';const token=${JSON.stringify(writeToken)};let data=fs.existsSync(file)?fs.readFileSync(file,'utf8'):'';const fd=fs.openSync(file,'a');if(!data.includes(token+'_START')){fs.writeSync(fd,token+'_START'+String.fromCharCode(10));fs.fsyncSync(fd);}if(process.argv.includes('--resume')){if(!data.includes(token+'_DONE'))fs.writeSync(fd,token+'_DONE'+String.fromCharCode(10));fs.fsyncSync(fd);fs.closeSync(fd);console.log('WRITE_DONE');}else{fs.writeFileSync('writer-ready.json',JSON.stringify({pid:process.pid}));const timer=setInterval(()=>{},100);const stop=()=>{clearInterval(timer);fs.closeSync(fd);fs.writeFileSync('writer-stopped.json','clean');};process.once('SIGTERM',stop);process.once('SIGINT',stop);}`
      )
    }
    await step("exit-during-active-task", async () => {
      const at = Date.now()
      holdAfterEvidence = state === "running"
      const task =
        state === "running"
          ? fixture.task
          : `First read the ENTIRE ${fixture.manifest[0].file} with limit=400 and retain its Evidence code and Next footer. Then ${state === "approval" ? `use write to create approval-output.txt containing exactly ${writeToken}` : "use bash to run node write-stage.cjs and wait for it"}. Do not combine or parallelize the read and write. Afterward continue following Next footers until END_OF_RESEARCH and report all six Evidence codes. Do not reread any completed page.`
      const child = state === "running" ? "Explore" : "general-purpose"
      await current.send(
        actor === "main"
          ? task
          : actor === "delegated"
            ? `First use ToolSearch with query "select:dispatch_agent", then dispatch_agent to ${child} with this task: ${task} Do not read source pages in the parent.`
            : `/agents run ${child} ${task}`
      )
      if (state === "running") {
        await current.wait(
          () => requests.some((r) => r.at >= at && r.heldAt),
          "active response after source evidence",
          90000,
          true
        )
      } else if (state === "approval") {
        await current.wait(
          () =>
            current.screen.flatText().includes("Allow once") &&
            current.screen.flatText().includes("Deny") &&
            !current.screen.flatText().includes("Allow dispatch_agent?"),
          "pending write approval",
          90000,
          actor === "delegated"
        )
        assert.equal(fs.existsSync(path.join(workspace, "approval-output.txt")), false)
      } else {
        await current.wait(
          () => fs.existsSync(path.join(workspace, "writer-ready.json")),
          "actual writer after durable first write",
          90000,
          true
        )
      }
      current.snapshot(`before-exit-${actor}-${state}`)
      const stopped = await normalExit({ active: true, packet: state === "approval" })
      holdAfterEvidence = false
      if (state === "running")
        assert.ok(
          requests.some((r) => r.at >= at && r.heldAt && r.cancelled),
          "exit must cancel active HTTP stream"
        )
      interrupted = incompleteRecords().find((r) => r.sessionId === owner)
      if (actor === "main") {
        assert.ok(
          rows().some(
            (r) =>
              r.file === `${owner}.jsonl` &&
              r.meta?.interrupted &&
              JSON.stringify(r.meta).includes(fixture.facts[0])
          ),
          "interrupted main transcript must preserve completed source evidence"
        )
      } else {
        assert.ok(
          interrupted?.resultText?.includes(fixture.facts[0]),
          "interrupted child journal must preserve completed source evidence"
        )
        assert.equal(interrupted.status, "interrupted")
      }
      if (state === "approval")
        assert.equal(
          fs.existsSync(path.join(workspace, "approval-output.txt")),
          false,
          "exit must not approve pending write"
        )
      if (state === "writing") {
        const writer = JSON.parse(fs.readFileSync(path.join(workspace, "writer-ready.json")))
        assert.throws(
          () => process.kill(writer.pid, 0),
          { code: "ESRCH" },
          "writer process must be stopped"
        )
        assert.equal(
          fs.readFileSync(path.join(workspace, "writer-stopped.json"), "utf8"),
          "clean",
          "writer must finish its signal cleanup"
        )
        assert.equal(
          fs.readFileSync(path.join(workspace, "progress-output.txt"), "utf8"),
          `${writeToken}_START\n`
        )
      }
      return {
        actor,
        state,
        ...stopped,
        partialEvidenceRetained: true,
        ...(interrupted ? { runId: interrupted.runId } : {}),
      }
    })
    await step(
      "restart-and-complete-active-task",
      async () => {
        await launch(["--continue"])
        const at = Date.now()
        const action =
          state === "approval"
            ? `Request the normal tool permission to create approval-output.txt with exactly ${writeToken}, then execute when approved in the TUI. Submit the proposed write now so the TUI can ask for approval; the user will approve interactively.`
            : state === "writing"
              ? "Request the normal tool permission and finish the interrupted writer by running node write-stage.cjs --resume once approved in the TUI. Submit the proposed command now; the user will approve interactively. Preserve the existing START record exactly once."
              : ""
        const task =
          `${action} Finish the original linked-source research using the saved source evidence and its Next footer. Read ONLY the five remaining pages with read limit=400 until END_OF_RESEARCH. Do not reread or revalidate any part of the completed first page; its footer is already saved. No ls, glob, grep or other source-search commands. Return all six Evidence codes and their source-backed findings.`.trim()
        const prompt =
          actor === "main"
            ? task
            : `First use ToolSearch with query "select:dispatch_agent"; then only dispatch_agent with resume:"${interrupted.runId}" and follow-up: ${task} Return the complete child report and all six codes. Do not start another child investigation.`
        const result = await turn(prompt, undefined, { timeout: 360000, approve: true })
        for (const fact of fixture.facts)
          assert.ok(result.answer.includes(fact), "resumed report must retain every source fact")
        const inference = requests.filter((r) => r.at >= at && r.model)
        const first = actor === "main" ? inference[0] : inference.find((r) => r.resumedChild)
        assert.ok(
          first?.priorFactPresent,
          "first resumed request must carry persisted source evidence"
        )
        const priorIds = new Set(
          uniqueResearchReads(requests.filter((r) => r.at < at)).map((r) => r.id)
        )
        const reads = uniqueResearchReads(inference).filter((r) => !priorIds.has(r.id))
        assert.equal(reads.length, 5, "resume reads exactly the five remaining pages")
        assert.ok(
          reads.every((r) => r.path !== fixture.manifest[0].file),
          "completed page must not be reread"
        )
        if (state === "approval")
          assert.equal(
            fs.readFileSync(path.join(workspace, "approval-output.txt"), "utf8").trim(),
            writeToken
          )
        if (state === "writing")
          assert.equal(
            fs.readFileSync(path.join(workspace, "progress-output.txt"), "utf8"),
            `${writeToken}_START\n${writeToken}_DONE\n`
          )
        return {
          actor,
          state,
          persistedEvidenceInFirstRequest: true,
          allFactsRetained: true,
          newSourceReads: reads.length,
          requests: inference.length,
        }
      },
      ["exit-during-active-task"]
    )
    await step("normal-exit-after-active-resume", normalExit, ["restart-and-complete-active-task"])
  } else if (phase === "bridge") {
    const secret = `SKILL_FACT_${randomBytes(6).toString("hex")}`
    evidenceProbe = secret
    const skillDir = path.join(workspace, ".cognia/skills/child-bridge-probe")
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      `---\nname: Child Bridge Probe\ndescription: Verify a child session can progressively load this skill.\n---\nReport this exact fact after loading: ${secret}\n`
    )
    await step("startup-bridge", async () => {
      await launch()
      assert.equal(rows().length, 0)
      return { cold: true }
    })
    await step(
      "child-plugin-roundtrip",
      async () => {
        const at = Date.now()
        await current.send(
          "/agents run general-purpose Use ToolSearch with query select:clipboard_history_list, then call clipboard_history_list once with empty arguments. Do not use any other tools. Reply only PLUGIN_BRIDGE_OK if the actual plugin returns ok true; otherwise report its error."
        )
        await current.wait(
          () =>
            /Subagent "general-purpose"(?:(?:  \([^\n]*\))?:\s| failed:)/.test(
              current.screen.flatText()
            ),
          "child plugin completion",
          180000,
          true
        )
        completedSubagentResult(current.screen.flatText(), "general-purpose", "PLUGIN_BRIDGE_OK")
        assert.ok(
          current.approvals > 0,
          "default-mode child must reach the real TUI approval queue"
        )
        const inference = requests.filter((r) => r.at >= at && r.model)
        assert.ok(
          inference.some((r) =>
            r.hostResults?.some((t) => t.name === "clipboard_history_list" && t.ok)
          ),
          "completed real plugin result required"
        )
        current.snapshot("plugin-completed")
        return {
          requests: inference.length,
          pluginResultOk: true,
          coldParent: true,
          approvals: current.approvals,
        }
      },
      ["startup-bridge"]
    )
    let skillId
    await step(
      "enable-fixture-skill",
      async () => {
        await current.send("/skill list")
        await current.wait(
          () => current.screen.flatText().includes("Child Bridge Probe"),
          "disk skill discovery",
          60000
        )
        current.terminal.write("\u001b")
        await current.wait(current.idle, "skill panel closed")
        const findSkill = () => {
          const dir = path.join(home, "db.json.tables")
          if (!fs.existsSync(dir)) return
          for (const f of fs.readdirSync(dir).filter((f) => f.endsWith("--skills.json"))) {
            const found = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).find(
              (s) => s.name === "Child Bridge Probe"
            )
            if (found) return found.id
          }
        }
        await current.wait(() => Boolean((skillId = findSkill())), "persisted fixture skill", 30000)
        await current.send(`/skill enable ${skillId}`)
        await current.wait(
          () =>
            fs.existsSync(path.join(home, "skill-state.json")) &&
            JSON.parse(
              fs.readFileSync(path.join(home, "skill-state.json"), "utf8")
            ).enabled.includes(skillId),
          "skill enabled"
        )
        return { skillId, enabled: true }
      },
      ["startup-bridge"]
    )
    await step(
      "child-skill-roundtrip",
      async () => {
        const at = Date.now(),
          before = current.revision
        await current.send(
          `/agents run general-purpose Use ToolSearch query select:load_skill then load_skill with skill_id ${skillId}. Read the exact fact from its body and return that fact only. Do not read files or call other tools.`
        )
        await current.wait(
          () => current.revision > before && current.screen.flatText().includes(secret),
          "child skill report",
          180000,
          true
        )
        completedSubagentResult(current.screen.flatText(), "general-purpose", secret)
        const inference = requests.filter((r) => r.at >= at && r.model)
        assert.ok(
          inference.some((r) =>
            r.hostResults?.some((t) => t.name === "load_skill" && t.containsProbe)
          ),
          "loaded body must come from actual tool result"
        )
        return { requests: inference.length, loadedFact: true }
      },
      ["enable-fixture-skill"]
    )
    for (const cancel of [false, true])
      await step(
        cancel ? "child-question-dismiss" : "child-question-answer",
        async () => {
          const at = Date.now()
          const question = cancel ? "Dismiss child bridge question?" : "Choose child bridge color?"
          await current.send(
            `/agents run general-purpose Use ToolSearch query select:ask_user then call ask_user with question "${question}", options [{"value":"blue","label":"Blue"},{"value":"amber","label":"Amber"}], allowText false. Wait for the actual user answer. Reply ${cancel ? "DISMISSED only if the question was dismissed" : "with the exact selected label only"}. Do not assume an answer or use other tools.`
          )
          await current.wait(
            () =>
              current.screen.flatText().includes(question) &&
              current.screen.flatText().includes("Space/Enter select"),
            "child ask-user overlay",
            180000,
            true
          )
          current.snapshot(cancel ? "question-before-dismiss" : "question-before-answer")
          if (cancel) current.terminal.write("\u001b")
          else {
            current.terminal.write("\u001b[B")
            await current.wait(
              () => /❯.*Amber/.test(current.screen.flatText()),
              "acknowledged Amber selection"
            )
            current.terminal.write("\r")
          }
          const marker = cancel ? "DISMISSED" : "Amber"
          await current.wait(
            () => {
              try {
                completedSubagentResult(current.screen.flatText(), "general-purpose", marker)
                return requests.some(
                  (r) =>
                    r.at >= at &&
                    r.hostResults?.some(
                      (t) => t.name === "ask_user" && (cancel ? t.dismissed : t.selectedAmber)
                    )
                )
              } catch {
                return false
              }
            },
            "child question result",
            180000,
            true
          )
          current.snapshot(cancel ? "question-dismissed" : "question-answered")
          return {
            requests: requests.filter((r) => r.at >= at && r.model).length,
            answered: !cancel,
            dismissed: cancel,
          }
        },
        ["startup-bridge"]
      )
    await step("normal-exit-after-child-tools", normalExit, [
      "child-plugin-roundtrip",
      "child-skill-roundtrip",
      "child-question-answer",
      "child-question-dismiss",
    ])
  } else if (phase === "shutdown") {
    const fixture = researchFixture(6)
    await step("startup-shutdown", async () => {
      await launch()
      return { isolatedProfile: true }
    })
    await step(
      "main-before-exit",
      async () => {
        const result = await turn(
          "Compute 19 + 23. Reply with only the number. Do not use tools.",
          "42"
        )
        return { toolNames: result.toolNames }
      },
      ["startup-shutdown"]
    )
    await step(
      "child-before-exit",
      async () => {
        const at = Date.now()
        await current.send(`/agents run Explore ${fixture.task}`)
        await current.wait(
          () => incompleteRecords().some((r) => r.startedAt >= at && r.status === "error"),
          "incomplete child before exit",
          120000
        )
        return { incomplete: true }
      },
      ["main-before-exit"]
    )
    await step("normal-exit", normalExit, ["child-before-exit"])
  } else if (phase === "pressure") {
    const pages = Number(process.env.COGNIA_TUI_LIVE_RESEARCH_PAGES || 38)
    assert.ok(Number.isInteger(pages) && pages >= 22, "pressure corpus must exceed twenty reads")
    const timeoutMs = Number(process.env.COGNIA_TUI_LIVE_PLAN_TIMEOUT_MS || 900000)
    assert.ok(
      Number.isSafeInteger(timeoutMs) && timeoutMs > 0,
      "explicit pressure observation timeout must be positive"
    )
    const fixture = researchFixture(pages)
    await step("startup-pressure", async () => {
      await launch()
      return {
        contextWindow: researchWindow,
        aiSdkMaxSteps: 128,
        sourcePages: pages,
        timeoutMs,
        isolatedProfile: true,
      }
    })
    await step(
      "pressure-explore-plan",
      async () => {
        const at = Date.now()
        await current.send(`/plan explore ${fixture.task}`)
        await current.wait(
          () =>
            savedPlans().some((p) => p.modified >= at) ||
            /Plan exploration failed/.test(current.screen.flatText()),
          "pressure plan delivery",
          timeoutMs
        )
        assert.doesNotMatch(current.screen.flatText(), /Plan exploration failed/)
        const plan = savedPlans().find((p) => p.modified >= at)
        assert.ok(plan)
        for (const fact of fixture.facts)
          assert.ok(plan.text.includes(fact), `final plan lost ${fact}`)
        const behaviors = sourceFindingEvidence(plan.text, fixture.manifest)
        const inference = requests.filter((r) => r.at >= at && r.model)
        const transport = completedInferenceEvidence(inference)
        const boundary = inference.findIndex(
          (r) => r.agentRole === "Explore" && r.hasSummary && r.checkpoints.length > 0
        )
        if (researchWindow < 936000)
          assert.ok(boundary >= 0, "must publish a structured checkpoint after actual compaction")
        const reads = uniqueResearchReads(inference)
        assert.equal(reads.length, fixture.manifest.length, "no repeated completed source reads")
        assert.equal(new Set(reads.map((r) => r.path)).size, fixture.manifest.length)
        assert.equal(
          uniqueResearchReads(inference.filter((row) => row.agentRole === "Explore")).length,
          fixture.manifest.length,
          "Explore must complete the corpus before handing its report to Plan"
        )
        assert.equal(
          uniqueResearchReads(inference.filter((row) => row.agentRole === "Plan")).length,
          0,
          "Plan must reuse Explore evidence without rereading source pages"
        )
        assert.ok(
          boundary < 0 || inference.slice(boundary).some((r) => r.toolNames.includes("read")),
          "new source work must follow compaction"
        )
        assert.ok(inference.at(-1).priorFactPresent, "Plan must receive retained Explore evidence")
        const actorInputs = inference.filter((r) => !r.summaryCall && r.usage?.prompt_tokens)
        const peakPromptTokens = Math.max(...actorInputs.map((r) => r.usage.prompt_tokens))
        const checkpointFacts = inference
          .flatMap((r) => r.checkpoints)
          .map(
            (checkpoint) =>
              new Set(JSON.stringify(checkpoint).match(/SOURCE_FACT_[0-9]+_[a-z0-9]+/g) || []).size
          )
        assert.ok(
          boundary < 0 || Math.max(...checkpointFacts) >= Math.floor(pages / 2),
          "checkpoint must advance beyond initial facts"
        )
        const failedInputs = inference
          .filter((r) => r.summaryCall && r.completed && r.finish !== "stop")
          .map((r) => r.inputHash)
        assert.equal(
          new Set(failedInputs).size,
          failedInputs.length,
          "failed summary inputs must not be billed repeatedly"
        )
        assert.ok(
          peakPromptTokens <= researchWindow,
          "actual actor prompt must remain within the configured pressure window"
        )
        current.snapshot("pressure-plan-completed")
        return {
          requests: inference.length,
          ...transport,
          sourceReads: reads.length,
          checkpointRequests: inference.filter((r) => r.checkpoints.length).length,
          peakPromptTokens,
          checkpointFactCounts: [...new Set(checkpointFacts)],
          plan: plan.file,
          firstFactRetained: true,
          allFactsRetained: true,
          sourceBehaviorsRetained: behaviors.length,
        }
      },
      ["startup-pressure"]
    )
    await step(
      "normal-exit-after-pressure-plan",
      async () => {
        await dismissPlanReview()
        return normalExit()
      },
      ["pressure-explore-plan"]
    )
  } else if (phase === "budget") {
    const fixture = researchFixture(Number(process.env.COGNIA_TUI_LIVE_RESEARCH_PAGES || 6))
    let correction
    let limited
    let owner
    let completedReadCount
    await step("startup-budget", async () => {
      await launch()
      const r = await turn("Without tools, calculate 7 * 9 and reply only 63.", "63")
      assert.deepEqual(r.toolNames, [], "owner fixture must not invoke memory or other tools")
      owner = r.session.replace(/\.jsonl$/, "")
      return { aiSdkMaxSteps: budgetSteps, owner }
    })
    await step(
      "manual-budget-exhaustion",
      async () => {
        const at = Date.now()
        await current.send(`/agents run Explore ${fixture.task}`)
        await current.wait(
          () => incompleteRecords().some((r) => r.status === "error" && r.startedAt >= at),
          "durable incomplete research",
          budgetTimeoutMs
        )
        limited = incompleteRecords().find((r) => r.status === "error" && r.startedAt >= at)
        completedReadCount = uniqueResearchReads(requests.filter((r) => r.at >= at)).length
        assert.ok(completedReadCount > 0 && completedReadCount < fixture.manifest.length)
        assert.equal(limited.sessionId, owner)
        assert.ok(limited.resultText.includes("Task/research incomplete"))
        assert.ok(
          limited.resultText.includes(fixture.facts[0]),
          "saved actual read evidence must contain the first fact"
        )
        assert.ok(limited.resultText.includes(`resume:\"${limited.runId}\"`))
        const checkpointRetained = limited.resultText.includes("<research-progress>")
        if (correctionRun && budgetSteps >= 10 && fixture.manifest.length >= 20)
          assert.ok(
            checkpointRetained,
            "budget stop must persist the actual accumulated checkpoint"
          )
        current.snapshot("budget-incomplete")
        return {
          runId: limited.runId,
          owner: limited.sessionId,
          runStatus: limited.status,
          partialEvidenceRetained: true,
          checkpointRetained,
          requests: requests.filter((r) => r.at >= at && r.model).length,
        }
      },
      ["startup-budget"]
    )
    await step(
      "restart-and-resume-budget",
      async () => {
        const stopped = await normalExit()
        const durable = incompleteRecords().find((row) => row.runId === limited.runId)
        assert.equal(durable?.resultText, limited.resultText, "normal exit retained evidence")
        if (correctionRun) {
          const file = fixture.manifest[0].file
          const obsolete = fixture.facts[0]
          const revised = `REVISED_SOURCE_${randomBytes(8).toString("hex")}`
          const target = path.join(workspace, file)
          fs.writeFileSync(target, fs.readFileSync(target, "utf8").replaceAll(obsolete, revised))
          fixture.facts[0] = revised
          correction = { file, obsolete, revised }
          fs.writeFileSync(
            path.join(root, "source-correction.json"),
            JSON.stringify(correction, null, 2)
          )
        }
        const config = JSON.parse(fs.readFileSync(configFile, "utf8"))
        config.aiSdkMaxSteps = 128
        fs.writeFileSync(configFile, JSON.stringify(config, null, 2), { mode: 0o600 })
        await launch(["--continue"])
        const at = Date.now()
        const r = await turn(
          `First use ToolSearch with exactly query "select:dispatch_agent"; then use only dispatch_agent with resume:"${limited.runId}" to finish the original unfinished Explore task from its saved source evidence. The follow-up is: ${correction ? `The source ${correction.file} changed after your earlier read. This new instruction supersedes the earlier no-reread rule for that changed file only. Read it once to discover the current Evidence code. Explicitly supersede the old finding with this standalone, unbulleted and unformatted line (no list or quote prefix): Source correction: <obsolete Evidence code> -> <current Evidence code>. Reopen its same-ID completed workstream with a correction reason if present. Retain all other completed source evidence and read only the remaining unread pages.` : "Continue only the next unread page; preserve every prior Evidence code and read only missing pages. Do not reread completed pages."} Then deliver the complete report. Do not use working_set, attachment, monitor, memory or other parent tools. Do not start a fresh investigation. Return the complete child report with all current Evidence codes and any explicit source correction. Preserve its complete <source-findings> JSON array verbatim, including both tags, behavior text and copied/original source citations; do not convert it to a table or abridge its rows. Keep the Source correction line standalone, unbulleted and unformatted, with no list or quote prefix; preserve both observed codes.`,
          undefined,
          { timeout: budgetTimeoutMs, approve: true }
        )
        assert.ok(
          r.toolNames.every((name) => ["ToolSearch", "dispatch_agent"].includes(name)),
          "parent continuation must use only the real resume tool"
        )
        for (const fact of fixture.facts)
          assert.ok(r.answer.includes(fact), `resumed final report lost ${fact}`)
        const behaviors = sourceFindingEvidence(
          r.answer,
          fixture.manifest.map((page, i) => ({ ...page, fact: fixture.facts[i] }))
        )
        if (correction) sourceCorrectionEvidence(r.answer, correction)
        const inference = requests.filter((row) => row.at >= at && row.model)
        const firstChild = inference.find((row) => row.resumedChild && !row.summaryCall)
        assert.ok(
          firstChild?.priorFactPresent,
          "the first resumed child request must carry persisted prior evidence"
        )
        const transport = completedInferenceEvidence(inference)
        assert.equal(r.session.replace(/\.jsonl$/, ""), owner)
        const priorReads = new Set(recordedReadPaths(limited.resultText))
        assert.equal(
          priorReads.size,
          completedReadCount,
          "journal must retain every completed read"
        )
        const reads = uniqueResearchReads(inference)
        if (correction)
          assert.equal(
            reads.filter((read) => read.path.endsWith(correction.file)).length,
            1,
            "changed source must be reverified exactly once"
          )
        assert.ok(
          reads.every(
            (read) =>
              !priorReads.has(read.path) || (correction && read.path.endsWith(correction.file))
          ),
          "resume only revisits the explicitly changed source"
        )
        assert.equal(
          reads.length + priorReads.size,
          fixture.manifest.length + (correction ? 1 : 0),
          "resume must not repeat completed source reads"
        )
        assert.equal(
          new Set([...priorReads, ...reads.map((read) => read.path)]).size,
          fixture.manifest.length
        )
        return {
          owner,
          runId: limited.runId,
          requests: inference.length,
          ...transport,
          sourceReads: reads.length + priorReads.size,
          persistedEvidenceInFirstChildRequest: true,
          allFactsRetained: true,
          sourceBehaviorsRetained: behaviors.length,
          restartMethod: "normal /exit with terminal restoration and database disposal",
          submitToExitMs: stopped.submitToExitMs,
          ...(correction
            ? { sourceCorrectionReported: true, correctedFact: correction.revised }
            : {}),
        }
      },
      ["manual-budget-exhaustion"]
    )
    await step("normal-exit-after-resume", normalExit, ["restart-and-resume-budget"])
  } else if (phase === "repair") {
    fs.writeFileSync(path.join(workspace, "notes.txt"), "Project codename: ORCHID-7429\n")
    fs.writeFileSync(path.join(workspace, "calc.cjs"), "exports.add = (a, b) => a - b;\n")
    await step("startup-cold", async () => {
      await launch()
      assert.equal(rows().length, 0)
      return { cold: true }
    })
    await step(
      "cold-manual-explore",
      async () => {
        const at = Date.now()
        await current.send(
          "/agents run Explore Read calc.cjs and notes.txt. Report the project codename and explain add. Do not inspect other files."
        )
        await current.wait(
          () =>
            /Subagent "Explore"(?:(?:  \([^\n]*\))?:\s| failed:)/.test(current.screen.flatText()),
          "cold Explore completion",
          180000
        )
        const text = completedSubagentResult(current.screen.flatText(), "Explore", "ORCHID-7429")
        assert.match(text, /subtract|a - b|subtraction/i)
        const inference = requests.filter((r) => r.at >= at && r.model)
        assert.ok(inference.length > 0)
        assert.ok(
          inference.every(
            (r) =>
              r.model === model && r.status === 200 && r.completed && !r.error && !r.streamError
          )
        )
        assert.ok(inference.some((r) => r.toolNames.some((n) => /read/i.test(n))))
        current.snapshot("cold-explore-completed")
        return { requests: inference.length, sourceCodename: "ORCHID-7429" }
      },
      ["startup-cold"]
    )
    for (const [command, key, value] of [
      ["/mouse select", "mouse", "select"],
      ["/select off", "selection", "off"],
      ["/layout scrollback", "layout", "scrollback"],
    ]) {
      await step(`persist-${key}`, async () => {
        await current.send(command)
        await current.wait(
          () => JSON.parse(fs.readFileSync(configFile, "utf8"))[key] === value,
          `${key} saved`
        )
        if (key === "layout")
          await current.wait(() => !current.screen.altScreen, "scrollback terminal")
        return { value, persisted: true }
      })
    }
    await step("preferences-restart", async () => {
      await close()
      await launch()
      assert.equal(current.screen.altScreen, false)
      const config = JSON.parse(fs.readFileSync(configFile, "utf8"))
      assert.equal(config.layout, "scrollback")
      assert.equal(config.mouse, "select")
      assert.equal(config.selection, "off")
      await current.send("/layout fullscreen")
      await current.wait(
        () => current.screen.altScreen && current.idle(),
        "fullscreen composer restored"
      )
      assert.equal(JSON.parse(fs.readFileSync(configFile, "utf8")).layout, "fullscreen")
      return { restarted: true, fullscreenRestored: true }
    })
    await step("plan-reuses-explore", async () => {
      const at = Date.now()
      await current.send(
        "/plan explore Fix add in calc.cjs to add instead of subtract. Explore must read calc.cjs and notes.txt and retain ORCHID-7429. Plan must reuse those exploration facts and propose the minimal change plus a regression test, without rereading these two unchanged files. Do not edit files."
      )
      await current.wait(
        () =>
          /Approve.*plan|Accept.*plan|Plan ready|Implement this plan|Plan exploration failed/i.test(
            current.screen.flatText()
          ),
        "plan approval",
        240000
      )
      current.snapshot("explore-plan")
      assert.doesNotMatch(current.screen.flatText(), /Plan exploration failed/)
      const inference = requests.filter((r) => r.at >= at && r.model)
      assert.ok(inference.length >= 2)
      assert.ok(
        inference.every((r) => r.status === 200 && r.completed && !r.error && !r.streamError)
      )
      assert.match(current.screen.flatText(), /ORCHID-7429|calc.cjs/)
      return { requests: inference.length, planVisible: true }
    })
  } else if (phase === "core") {
    fs.writeFileSync(path.join(workspace, "notes.txt"), "Project codename: ORCHID-7429\n")
    fs.writeFileSync(path.join(workspace, "calc.cjs"), "exports.add = (a, b) => a - b;\n")
    fs.writeFileSync(
      path.join(workspace, "calc.test.cjs"),
      "const {test}=require('node:test');const assert=require('node:assert/strict');const {add}=require('./calc.cjs');test('adds positive and negative values',()=>{assert.equal(add(4,7),11);assert.equal(add(-3,8),5)});\n"
    )
    execFileSync("rtk", ["proxy", "git", "init", "-q"], { cwd: workspace })
    execFileSync("rtk", ["proxy", "git", "add", "notes.txt", "calc.cjs", "calc.test.cjs"], {
      cwd: workspace,
    })
    execFileSync(
      "rtk",
      [
        "proxy",
        "git",
        "-c",
        "user.name=Acceptance",
        "-c",
        "user.email=acceptance@example.invalid",
        "commit",
        "-qm",
        "fixture",
      ],
      { cwd: workspace }
    )
    await step("startup", async () => {
      await launch()
      return { fullscreen: current.screen.altScreen }
    })
    await step("basic-chat", () =>
      turn("What is 1847 plus 2939? Reply only with the decimal sum.", "4786")
    )
    await step("multi-turn", () =>
      turn("Double your previous numeric answer. Reply only with the result.", "9572")
    )
    await step("read-tool", async () => {
      const r = await turn(
        "Read notes.txt with a file tool. Reply only with the project codename stored in it.",
        "ORCHID-7429"
      )
      assert.ok(r.toolNames.some((n) => /read/i.test(n)))
      return r
    })
    await step("write-with-approval", async () => {
      const r = await turn(
        "Use a file tool to create result.txt containing exactly the number 18 and a newline. Reply only WRITE_DONE after writing it.",
        "WRITE_DONE",
        { approve: true }
      )
      assert.equal(fs.readFileSync(path.join(workspace, "result.txt"), "utf8"), "18\n")
      assert.ok(r.approvals > 0)
      return r
    })
    await step("coding-and-shell", async () => {
      const before = fs.readFileSync(path.join(workspace, "calc.test.cjs"), "utf8")
      const r = await turn(
        "Fix add in calc.cjs to add correctly. Read and edit implementation, run node --test calc.test.cjs. Do not change the test. Reply only REPAIR_DONE after tests pass.",
        "REPAIR_DONE",
        { approve: true }
      )
      assert.equal(fs.readFileSync(path.join(workspace, "calc.test.cjs"), "utf8"), before)
      const output = execFileSync("rtk", ["proxy", "node", "--test", "calc.test.cjs"], {
        cwd: workspace,
        encoding: "utf8",
      })
      fs.writeFileSync(path.join(root, "coding-independent-test.log"), output)
      assert.ok(r.toolNames.some((n) => /bash|shell|exec/i.test(n)))
      return r
    })
    await step("session-memory-set", () =>
      turn(
        "Keep the fictional label SILVER-IBIS-9361 in our conversation context only. Do not use any tools. Reply only ACKNOWLEDGED.",
        "ACKNOWLEDGED"
      )
    )
    await step("terminal-cleanup", close)
    await step("resume-context", async () => {
      await launch(["--continue"])
      return turn(
        "What fictional project label did I ask you to remember? Reply only with the label.",
        "SILVER-IBIS-9361"
      )
    })
    await step("export-json", async () => {
      const exports = () =>
        fs.readdirSync(workspace).filter((n) => /^cognia-export-.*\.json$/.test(n))
      const before = new Map(
        exports().map((file) => [file, fs.statSync(path.join(workspace, file)).mtimeMs])
      )
      await current.send("/export json")
      const fresh = () =>
        exports().find(
          (file) =>
            !before.has(file) || fs.statSync(path.join(workspace, file)).mtimeMs > before.get(file)
        )
      await current.wait(() => fresh(), "newly written export file")
      const file = fresh()
      const data = JSON.parse(fs.readFileSync(path.join(workspace, file), "utf8"))
      assert.match(JSON.stringify(data), /SILVER-IBIS-9361/)
      return { file, validJson: true, freshWrite: true }
    })
  } else if (phase.startsWith("panels")) {
    const cases = [
      ["/help", /Commands/],
      ["/settings", /Settings/],
      ["/model", /Switch model/],
      ["/provider inspect tui-local", /Provider · tui-local/],
      ["/tools", /Tools|Tool catalog|Built-in tools/],
      ["/usage", /Usage|Token usage/],
      ["/context", /Context/],
      ["/doctor", /Doctor|Diagnostics|Provider protocol/],
      ["/transcript", /Transcript/],
      ["/diff", /Git diff|Changes|No .*changes/],
      ["/permissions list", /Permission|approval|No .*rule/],
      ["/mcp list", /MCP/],
      ["/skill list", /Skills|No .*skill/],
      ["/memory list", /No memories|Stored memories/],
      ["/workflow list", /Run workflow|Choose a workflow|Inspect workflow|No workflows|Workflows/],
      ["/agents list", /Subagents|Agents|Explore/],
      ["/team list", /Inspect team|No teams|Teams/],
      ["/tasks list", /No scheduled|Scheduled tasks/],
      ["/hooks list", /Configured hooks \(\d+\)/],
      ["/limits presets", /Limits presets/],
      ["/sessions", /Resume session/],
      ["/plan list", /No saved plans|Plans|Saved plans/],
      ["/goal list", /No goals|Goals/],
      ["/layout", /Layout/],
    ]
    const selected = process.env.COGNIA_TUI_LIVE_CASES?.split(",")
    for (const [command, pattern] of cases.filter(
      ([command]) => !selected || selected.includes(command)
    ))
      await step(command.slice(1).replaceAll(" ", "-"), () => panel(command, pattern))
  } else if (phase.startsWith("advanced")) {
    await step("startup-continued", async () => {
      await launch(["--continue"])
      return { fullscreen: current.screen.altScreen }
    })
    await step("layout-scrollback", async () => {
      await current.send("/layout scrollback")
      await current.wait(() => !current.screen.altScreen, "leave alternate screen")
      assert.equal(JSON.parse(fs.readFileSync(configFile, "utf8")).layout, "scrollback")
      return { persisted: true }
    })
    await step("layout-fullscreen", async () => {
      await current.send("/layout fullscreen")
      await current.wait(() => current.screen.altScreen, "enter alternate screen")
      assert.equal(JSON.parse(fs.readFileSync(configFile, "utf8")).layout, "fullscreen")
      return { persisted: true }
    })
    await step("resize-narrow-and-restore", async () => {
      current.screen.resize(72, 20)
      current.terminal.resize(72, 20)
      await current.wait(() => current.screen.flatText().includes("ark-deepseek"), "narrow footer")
      current.snapshot("narrow")
      assert.equal(current.screen.rows, 20)
      current.screen.resize(240, 48)
      current.terminal.resize(240, 48)
      await current.wait(current.idle, "resized composer")
      return { narrow: "72x20", restored: "240x48" }
    })
    await step("cancel-stream", async () => {
      const at = Date.now()
      await current.send(
        "Write an extremely detailed explanation of JavaScript event loops, at least 5000 words. Do not use tools."
      )
      await current.wait(
        () => requests.some((r) => r.at >= at && r.status === 200 && !r.completed),
        "active upstream stream",
        60000
      )
      current.terminal.write("\u001b")
      await current.wait(
        () => current.screen.flatText().includes("Turn stopped by user") && current.idle(),
        "cancelled turn and idle",
        30000
      )
      await current.wait(
        () => requests.some((r) => r.at >= at && r.cancelled),
        "upstream stream cancelled",
        10000
      )
      return { upstreamCancelled: true }
    })
    await step("chat-after-cancel", () =>
      turn("What is 123 times 47? Reply only with the decimal result.", "5781")
    )
    await step("approval-detail-and-deny", async () => {
      const target = path.join(workspace, "denied.txt")
      assert.equal(fs.existsSync(target), false)
      await current.send(
        "First use ToolSearch to load sandbox_write, then use it to create denied.txt with DENIED_SENTINEL. Only after approval is denied, do not retry or use another tool; report the denial."
      )
      await current.wait(
        () =>
          current.screen.flatText().includes("Allow once") &&
          current.screen.flatText().includes("Deny"),
        "write approval",
        90000
      )
      current.terminal.write("v")
      await current.wait(
        () => /Review.*write/i.test(current.screen.flatText()),
        "approval argument detail"
      )
      current.snapshot("approval-detail")
      assert.equal(fs.existsSync(target), false)
      current.terminal.write("\u001b")
      await current.wait(
        () => current.screen.flatText().includes("Allow once"),
        "return from detail without approving"
      )
      current.terminal.write("\u001b[B")
      await current.wait(
        () => /❯ Allow always/.test(current.screen.flatText()),
        "select allow always"
      )
      current.terminal.write("\u001b[B")
      await current.wait(() => /❯ Deny/.test(current.screen.flatText()), "select deny")
      current.terminal.write("\r")
      await current.wait(current.idle, "denied turn settled", 90000)
      assert.equal(fs.existsSync(target), false)
      return { detailWithoutDecision: true, deniedFileAbsent: true }
    })
    await step("memory-add", async () => {
      await current.send("/remember The acceptance project uses ceramic owl labels.")
      await current.wait(
        () =>
          current.screen
            .flatText()
            .includes("Remembered: The acceptance project uses ceramic owl labels."),
        "memory saved",
        30000
      )
      return { saved: true }
    })
    await step("memory-persisted-restart", async () => {
      await close()
      await launch(["--continue"])
      await current.send("/memory list")
      await current.wait(
        () =>
          current.screen.flatText().includes("Stored memories") &&
          current.screen.flatText().includes("ceramic owl"),
        "persisted memory picker"
      )
      current.snapshot("memory-after-restart")
      return { persisted: true }
    })
    await step("explore-subagent", async () => {
      await close()
      await launch(["--continue"])
      const at = Date.now()
      await current.send(
        "/agents run Explore Read calc.cjs and notes.txt. Report the project codename and explain add. Do not inspect any other files."
      )
      await current.wait(
        () => /Subagent "Explore"(?:(?:  \([^\n]*\))?:\s| failed:)/.test(current.screen.flatText()),
        "Explore completed source-backed summary",
        180000
      )
      completedSubagentResult(current.screen.flatText(), "Explore", "ORCHID-7429")
      const inference = requests.filter((r) => r.at >= at && r.model)
      assert.ok(inference.length > 0)
      assert.ok(
        inference.every(
          (r) => r.model === model && r.status === 200 && r.completed && !r.streamError && !r.error
        )
      )
      assert.ok(inference.some((r) => r.toolNames.some((n) => /read/i.test(n))))
      current.snapshot("explore-completed")
      return { requests: inference.length, model }
    })
    await step("workflow-create", async () => {
      await close()
      await launch(["--continue"])
      await current.send("/workflow create Ceramic Acceptance")
      await current.wait(
        () =>
          current.screen.flatText().includes("Workflow copilot") &&
          current.screen.flatText().includes("Ceramic Acceptance"),
        "workflow copilot created",
        30000
      )
      current.snapshot("workflow-created")
      return { created: true }
    })
    await step(
      "workflow-propose",
      async () => {
        const r = await turn(
          "Create a tiny workflow: a manual trigger followed by a transform that outputs the literal string CERAMIC_OK. Use workflow proposal tools. Do not execute it yet.",
          undefined,
          { timeout: 180000, confirmation: true, approve: true }
        )
        assert.ok(
          r.toolNames.some((n) => /wf_.*propos|wf_.*patch|wf_.*add/i.test(n)),
          "must actually call a proposal tool"
        )
        return r
      },
      ["workflow-create"]
    )
    await step(
      "workflow-apply-save",
      async () => {
        await current.wait(
          () => /Apply workflow proposal\?|No proposal to apply/.test(current.screen.flatText()),
          "proposal confirmation"
        )
        assert.ok(current.screen.flatText().includes("Apply workflow proposal?"))
        current.terminal.write("\r")
        await current.wait(
          () => /Applied \d+ change\(s\) and saved/.test(current.screen.flatText()),
          "workflow persisted"
        )
        current.snapshot("workflow-applied")
        return { applied: true }
      },
      ["workflow-propose"]
    )
    await step(
      "workflow-exit",
      async () => {
        await current.send("/workflow exit")
        await current.wait(
          () => current.screen.flatText().includes("Left workflow copilot"),
          "leave workflow mode"
        )
        return { exited: true }
      },
      ["workflow-create"]
    )
  } else if (phase === "settings") {
    await step("startup-continued", async () => {
      await launch(["--continue"])
      return { resumed: true }
    })
    await step("settings-enum-cancel", async () => {
      await current.send("/settings")
      await current.wait(() => current.screen.flatText().includes("Settings"), "settings overlay")
      current.terminal.write("\t")
      await current.wait(
        () => current.screen.flatText().includes("Mascot style"),
        "appearance section"
      )
      current.terminal.write("\t")
      await current.wait(() => current.screen.flatText().includes("Language"), "display section")
      current.terminal.write("\r")
      await current.wait(() => /‹ en ›/.test(current.screen.flatText()), "enum draft")
      current.terminal.write("\u001b[C")
      await current.wait(() => /‹ zh-CN ›/.test(current.screen.flatText()), "locale preview")
      assert.equal(JSON.parse(fs.readFileSync(configFile, "utf8")).locale, "en")
      current.terminal.write("\u001b")
      await current.wait(() => !current.screen.flatText().includes("‹ zh-CN ›"), "draft cancelled")
      assert.equal(JSON.parse(fs.readFileSync(configFile, "utf8")).locale, "en")
      return { previewNotPersisted: true }
    })
    await step(
      "settings-locale-save-and-restore",
      async () => {
        current.terminal.write("\r")
        await current.wait(() => /‹ en ›/.test(current.screen.flatText()), "new enum draft")
        current.terminal.write("\u001b[C")
        await current.wait(() => /‹ zh-CN ›/.test(current.screen.flatText()), "new locale preview")
        current.terminal.write("\r")
        await current.wait(
          () =>
            JSON.parse(fs.readFileSync(configFile, "utf8")).locale === "zh-CN" &&
            current.screen.flatText().includes("设置"),
          "Chinese applied and persisted"
        )
        current.snapshot("locale-zh")
        current.terminal.write("\r")
        await current.wait(() => /‹ zh-CN ›/.test(current.screen.flatText()), "Chinese enum draft")
        current.terminal.write("\u001b[C")
        await current.wait(() => /‹ en ›/.test(current.screen.flatText()), "English preview")
        current.terminal.write("\r")
        await current.wait(
          () =>
            JSON.parse(fs.readFileSync(configFile, "utf8")).locale === "en" &&
            current.screen.flatText().includes("Settings"),
          "English restored"
        )
        current.terminal.write("\u001b")
        await current.wait(current.idle, "close settings")
        return { savedZh: true, restoredEn: true }
      },
      ["settings-enum-cancel"]
    )
    await step("memory-delete", async () => {
      await close()
      await launch(["--continue"])
      const file = path.join(home, "db.json.tables/cognia-claude--memories.json")
      const memories = () => JSON.parse(fs.readFileSync(file, "utf8"))
      const memory = memories().find((r) => r.text?.includes("ceramic owl"))
      assert.ok(memory, "previously saved memory must exist")
      await current.send(`/memory delete ${memory.id}`)
      await current.wait(
        () => current.screen.flatText().includes(`Deleted memory ${memory.id}.`),
        "audited memory delete"
      )
      await current.wait(
        () => !memories().some((r) => r.id === memory.id),
        "deleted memory flushed to store"
      )
      return { removed: true, durable: true }
    })
    await step("mouse-setting-persistence", async () => {
      await current.send("/mouse select")
      await current.wait(
        () => /Mouse: select|Mouse mode updated/.test(current.screen.flatText()),
        "mouse mode applied"
      )
      assert.equal(JSON.parse(fs.readFileSync(configFile, "utf8")).mouse, "select")
      return { persisted: true }
    })
    await step("selection-setting-persistence", async () => {
      await current.send("/select off")
      await current.wait(
        () => /Selection: off|Selection mode updated/.test(current.screen.flatText()),
        "selection mode applied"
      )
      assert.equal(JSON.parse(fs.readFileSync(configFile, "utf8")).selection, "off")
      return { persisted: true }
    })
  } else if (phase.startsWith("compaction")) {
    await step("startup-continued", async () => {
      await launch(["--continue"])
      return { resumed: true }
    })
    await step("source-context-fixture", async () => {
      const dir = path.join(workspace, "source")
      fs.mkdirSync(dir, { recursive: true })
      for (const [from, to] of [
        ["cli/src/tui/runtime/settings-sections.ts", "settings-sections.ts"],
        ["cli/src/config/schema.ts", "config-schema.ts"],
      ])
        fs.copyFileSync(path.join(repo, from), path.join(dir, to))
      const r = await turn(
        "For the compaction test, load the previously unread source ranges: lines 351-700 and 701-1050 of BOTH source/settings-sections.ts and source/config-schema.ts. Use read only, no searches or edits: the source context itself must be loaded to exercise the default retained-token policy. Then concisely summarize those ranges and retain the already researched aiSdkMaxSteps, subagentMaxDepth and fictional labels.",
        undefined,
        { timeout: 180000 }
      )
      assert.ok(
        r.toolNames.filter((n) => n === "read").length >= 4,
        "must read source pages rather than infer from old context"
      )
      assert.match(r.answer, /256/)
      const usage = requests.filter((row) => row.model && row.usage).at(-1)?.usage
      assert.ok(
        usage?.prompt_tokens >= 26000,
        "default 12000-token retained tail needs a sufficiently large conversation"
      )
      return { ...r, promptTokens: usage.prompt_tokens }
    })
    await step(
      "manual-compact-large-code-context",
      async () => {
        const at = Date.now()
        await current.send(
          "/compact Retain the source findings, aiSdkMaxSteps, subagentMaxDepth, and the fictional labels SILVER-IBIS-9361, ORCHID-7429 and AMBER-PIPIT-6048."
        )
        await current.wait(
          () =>
            /Context compacted|Compaction failed|Nothing to compact yet|Compaction skipped/.test(
              current.screen.flatText()
            ),
          "compaction boundary or explicit failure",
          120000
        )
        if (!current.screen.flatText().includes("Context compacted"))
          throw Error(
            current.screen
              .lines()
              .filter((line) =>
                /Compaction failed|Nothing to compact yet|Compaction skipped/.test(line)
              )
              .join("\n")
          )
        assert.ok(
          requests.some((r) => r.at >= at && r.model === model && r.completed && r.status === 200)
        )
        current.snapshot("compacted-large-code")
        return { boundary: true }
      },
      ["source-context-fixture"]
    )
    await step(
      "recall-after-real-compaction",
      async () => {
        const r = await turn(
          "Without tools, state the three retained fictional labels in order: original project label, source codename, newer test tag. Then state the researched aiSdkMaxSteps and subagentMaxDepth defaults. Use one concise line.",
          /SILVER-IBIS-9361[\s\S]*ORCHID-7429[\s\S]*AMBER-PIPIT-6048[\s\S]*256[\s\S]*2/
        )
        assert.equal(
          r.toolNames.length,
          0,
          "recall should reuse findings without repeating source research"
        )
        return r
      },
      ["manual-compact-large-code-context"]
    )
  } else if (phase.startsWith("session")) {
    await step("startup-continued", async () => {
      await launch(["--continue"])
      return { resumed: true }
    })
    await step("session-control-turn", () =>
      turn(
        "Using this conversation only, give the fictional project label and the source project codename. No tools. Reply with those two labels only.",
        /SILVER-IBIS-9361[\s\S]*ORCHID-7429/
      )
    )
    await step("compaction-conversation-fixture", async () => {
      const evidence = []
      for (const [prompt, answer] of [
        [
          "Retain the fictional test tag AMBER-PIPIT-6048 for recall after compaction. Without tools compute 31 times 17 and reply only with the decimal result.",
          "527",
        ],
        [
          "What project codename was read from notes.txt earlier? No tools; reply only with the codename.",
          "ORCHID-7429",
        ],
        [
          "What fictional project label did I ask you to keep in this conversation? No tools; reply only with the label.",
          "SILVER-IBIS-9361",
        ],
        [
          "What does the corrected add function return for minus three and eight? No tools; reply only with the decimal result.",
          "5",
        ],
      ])
        evidence.push(await turn(prompt, answer))
      return { liveTurns: evidence.length }
    })
    await step(
      "manual-compact",
      async () => {
        const at = Date.now()
        await current.send(
          "/compact Preserve the fictional project label SILVER-IBIS-9361 and source codename ORCHID-7429."
        )
        await current.wait(
          () =>
            /Context compacted|Compaction failed|Could not compact|Compaction unavailable|Nothing to compact yet/.test(
              current.screen.flatText()
            ),
          "manual compaction outcome",
          90000
        )
        assert.ok(
          current.screen.flatText().includes("Context compacted"),
          "explicit compaction must publish a boundary"
        )
        assert.ok(
          requests.some((r) => r.at >= at && r.model === model && r.completed && r.status === 200)
        )
        current.snapshot("manual-compact")
        return { boundary: true }
      },
      ["compaction-conversation-fixture"]
    )
    await step(
      "recall-after-compact",
      () =>
        turn(
          "Give the original fictional project label, the source project codename, and the newer fictional test tag retained for after compaction, in that order. No tools. Reply with those three labels only.",
          /SILVER-IBIS-9361[\s\S]*ORCHID-7429[\s\S]*AMBER-PIPIT-6048/
        ),
      ["manual-compact"]
    )
    await step("rewind-file-setup", async () => {
      fs.writeFileSync(path.join(workspace, "rewind-existing.txt"), "ORIGINAL_REWIND\n")
      const r = await turn(
        "REWIND_V41: Use ToolSearch to load sandbox_write. Overwrite rewind-existing.txt with CHANGED_REWIND plus newline and create rewind-created.txt containing CREATED_REWIND plus newline. No other changes. Reply REWIND_READY.",
        "REWIND_READY",
        { approve: true }
      )
      assert.equal(
        fs.readFileSync(path.join(workspace, "rewind-existing.txt"), "utf8"),
        "CHANGED_REWIND\n"
      )
      assert.equal(
        fs.readFileSync(path.join(workspace, "rewind-created.txt"), "utf8"),
        "CREATED_REWIND\n"
      )
      return r
    })
    await step(
      "rewind-files-only",
      async () => {
        const dir = path.join(home, "checkpoints")
        const checkpoints = fs.readdirSync(dir).flatMap((sid) =>
          fs.readdirSync(path.join(dir, sid)).flatMap((seq) => {
            const file = path.join(dir, sid, seq, "meta.json")
            return fs.existsSync(file) ? [JSON.parse(fs.readFileSync(file, "utf8"))] : []
          })
        )
        const cp = checkpoints.findLast((r) => r.label?.includes("REWIND_V41:"))
        assert.ok(cp, "write turn must have a durable checkpoint")
        const before = JSON.stringify(rows())
        await current.send(`/rewind files ${cp.seq}`)
        await current.wait(
          () =>
            fs.readFileSync(path.join(workspace, "rewind-existing.txt"), "utf8") ===
              "ORIGINAL_REWIND\n" && !fs.existsSync(path.join(workspace, "rewind-created.txt")),
          "overwrite restored and created path removed",
          15000
        )
        assert.equal(JSON.stringify(rows()), before, "files-only rewind must retain conversation")
        current.snapshot("rewind-files")
        return { originalRestored: true, createdRemoved: true, transcriptUnchanged: true }
      },
      ["rewind-file-setup"]
    )
    await step(
      "rewind-followup",
      () =>
        turn(
          "Read rewind-existing.txt. Reply only with its current content, without a trailing newline.",
          "ORIGINAL_REWIND"
        ),
      ["rewind-files-only"]
    )
    await step("read-after-file-rewind", async () => {
      assert.equal(
        fs.readFileSync(path.join(workspace, "rewind-existing.txt"), "utf8"),
        "ORIGINAL_REWIND\n"
      )
      const r = await turn(
        "Invoke the read tool again NOW for rewind-existing.txt. Do not reuse previous tool results: files-only rewind restored different bytes on disk. Reply only with the newly read file content, without trailing newline.",
        "ORIGINAL_REWIND"
      )
      assert.ok(r.toolNames.includes("read"), "this turn must make a new read call")
      return r
    })
    await step("export-markdown-and-jsonl", async () => {
      for (const [format, extension] of [
        ["markdown", "md"],
        ["jsonl", "jsonl"],
      ]) {
        const files = () =>
          fs
            .readdirSync(workspace)
            .filter((n) => n.startsWith("cognia-export-") && n.endsWith(`.${extension}`))
        const before = new Map(
          files().map((file) => [file, fs.statSync(path.join(workspace, file)).mtimeMs])
        )
        await current.send(`/export ${format}`)
        const fresh = () =>
          files().find(
            (file) =>
              !before.has(file) ||
              fs.statSync(path.join(workspace, file)).mtimeMs > before.get(file)
          )
        await current.wait(() => fresh(), `export ${format} newly written`)
        const data = fs.readFileSync(path.join(workspace, fresh()), "utf8")
        if (format === "jsonl")
          data
            .trim()
            .split("\n")
            .forEach((line) => assert.ok(JSON.parse(line).role))
        else assert.match(data, /# Conversation export/)
      }
      return { markdown: true, jsonl: true }
    })
    await step("goal-real-run", async () => {
      await current.send(
        "/goal Compute 17 times 19 and state the decimal result. Do not use tools; the goal is complete once the numeric answer is given."
      )
      await current.wait(
        () =>
          /Goal completed:|Goal paused:.*awaiting acceptance|Goal judge client unavailable|Goal failed:/.test(
            current.screen.flatText()
          ),
        "goal terminal outcome",
        120000
      )
      assert.match(
        current.screen.flatText(),
        /Goal completed:|Goal paused:.*awaiting acceptance/,
        "goal must reach completion or the explicit acceptance gate"
      )
      assert.match(current.screen.flatText(), /323/)
      current.snapshot("goal-completed")
      return {
        answerObserved: true,
        awaitingAcceptance: current.screen.flatText().includes("awaiting acceptance"),
      }
    })
    await step("goal-status-and-stop", async () => {
      await current.send("/goal status")
      await current.wait(
        () => /Goal .*paused/.test(current.screen.flatText()),
        "paused goal status"
      )
      await current.send("/goal stop")
      await current.wait(() => current.screen.flatText().includes("Goal stopped."), "explicit stop")
      const file = path.join(home, "db.json.tables/cognia-claude--chatGoals.json")
      await current.wait(
        () =>
          JSON.parse(fs.readFileSync(file, "utf8")).some(
            (r) => r.safeObjective?.includes("17 times 19") && r.status === "stopped"
          ),
        "stopped goal flushed"
      )
      return { stoppedDurably: true }
    })
    await step("normal-exit", async () => {
      await current.send("/exit")
      await current.wait(() => current.exited, "normal /exit", 20000)
      assert.equal(current.exitCode, 0)
      const cleanup = await close()
      return { ...cleanup, normal: true }
    })
  } else {
    throw Error(`Unknown phase ${phase}`)
  }
} finally {
  await step("final-terminal-cleanup", close)
  relay.closeAllConnections()
  await new Promise((resolve) => relay.close(resolve))
  save()
}
process.exitCode =
  results.some((r) => r.status === "failed" || r.status === "blocked") || fatalUpstream ? 1 : 0
