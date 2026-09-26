// P1 characterization pins for the tool-permission ladder (ADR-0197).
//
// Both dispatch rails decide every tool call through a permission ladder:
// the ai-sdk rail's `createToolPermissionGate` and the Claude Agent SDK rail's
// `canUseTool`. This file runs both across the decision space (tool class ×
// confinement × policy overlay × mode × doom state, plus a headless ai-sdk
// gate) and compares the result with a golden file, together with the approval
// frames, the pending-approval entries and a set of named edge cases.
//
// The rails differ on purpose in places: the Agent SDK enforces some modes
// natively, so its ladder leaves them alone. The golden pins each rail's
// behaviour exactly as it is, divergences included. Regenerate it with
// `UPDATE_GOLDEN=1` only for an intended behaviour change, and say why in the
// commit.

import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { createToolPermissionGate } from "../../../dispatch/ai-sdk-tools.mjs"
import {
  createAnthropicCanUseTool,
  enforceAnthropicPermissionChannel,
} from "../../../dispatch/anthropic.mjs"
import { createDoomLoopGuard } from "../doom-loop.ts"

const GOLDEN = new URL(
  "../../../test-support/fixtures/permission-ladder.golden.txt",
  import.meta.url
)

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cognia-ladder-root-")))
const OUTSIDE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cognia-ladder-out-")))

type Json = Record<string, unknown>
type Rail = "sdk" | "ai" | "ai-headless"
type Conf = "off" | "in" | "out" | "cred"
type Overlay = "none" | "rules-allow" | "rules-deny" | "suppress"

const RAILS: readonly Rail[] = ["sdk", "ai", "ai-headless"]
const MODES = ["default", "plan", "acceptEdits", "bypassPermissions", "dontAsk"] as const
const OVERLAYS: readonly Overlay[] = ["none", "rules-allow", "rules-deny", "suppress"]
const CONFS: readonly Conf[] = ["off", "in", "out", "cred"]

/** A plugin tool that declared read access and a path param in its manifest. */
const DECLARED_READ_PLUGIN = { name: "rg:search", access: "read", pathParams: ["path"] }

/** The path one tool call targets under a confinement variant. */
function target(conf: Conf, leaf = "a.ts"): string {
  if (conf === "out") return path.join(OUTSIDE, leaf)
  if (conf === "cred") return path.join(ROOT, ".ssh", "id_rsa")
  return path.join(ROOT, "src", leaf)
}

interface ToolCase {
  id: string
  name: string
  /** Whether the input carries a filesystem path confinement can judge. */
  paths: boolean
  input(conf: Conf): Json
}

const TOOLS: readonly ToolCase[] = [
  {
    id: "b.read",
    name: "mcp__cognia-tools__read",
    paths: true,
    input: (c) => ({ file_path: target(c) }),
  },
  {
    id: "b.write",
    name: "mcp__cognia-tools__write",
    paths: true,
    input: (c) => ({ file_path: target(c), content: "x" }),
  },
  {
    id: "b.file_move",
    name: "mcp__cognia-tools__file_move",
    paths: true,
    input: (c) => ({ source: path.join(ROOT, "src", "from.ts"), destination: target(c) }),
  },
  {
    id: "b.bash",
    name: "mcp__cognia-tools__bash",
    paths: true,
    input: (c) => ({ command: "ls", workdir: path.dirname(target(c)) }),
  },
  {
    id: "b.exit_plan",
    name: "mcp__cognia-tools__exit_plan_mode",
    paths: false,
    input: () => ({ plan: "p" }),
  },
  {
    id: "p.ask_user",
    name: "mcp__cognia-plugin-tools__ask_user",
    paths: false,
    input: () => ({ question: "q" }),
  },
  {
    id: "p.dispatch_agent",
    name: "mcp__cognia-plugin-tools__dispatch_agent",
    paths: false,
    input: () => ({ prompt: "p" }),
  },
  {
    id: "p.sandbox_write",
    name: "mcp__cognia-plugin-tools__sandbox_write",
    paths: false,
    input: () => ({ file_path: target("in"), content: "x" }),
  },
  {
    id: "p.declared_read",
    name: "mcp__cognia-plugin-tools__rg:search",
    paths: true,
    input: (c) => ({ path: target(c), pattern: "x" }),
  },
  {
    id: "p.other",
    name: "mcp__cognia-plugin-tools__notes:search",
    paths: false,
    input: () => ({ query: "q" }),
  },
  {
    id: "f.mcp",
    name: "mcp__github__create_issue",
    paths: false,
    input: () => ({ title: "t" }),
  },
  { id: "n.Read", name: "Read", paths: true, input: (c) => ({ file_path: target(c) }) },
  {
    id: "n.Write",
    name: "Write",
    paths: true,
    input: (c) => ({ file_path: target(c), content: "x" }),
  },
]

function sendOptionsFor(tool: ToolCase, conf: Conf, overlay: Overlay, mode: string): Json {
  return {
    permissionMode: mode,
    cwd: ROOT,
    pluginTools: [DECLARED_READ_PLUGIN],
    ...(conf === "off" ? {} : { confinement: { enabled: true, roots: [ROOT] } }),
    ...(overlay === "rules-allow" ? { permissionRuleset: { [tool.name]: "allow" } } : {}),
    ...(overlay === "rules-deny" ? { permissionRuleset: { [tool.name]: "deny" } } : {}),
    ...(overlay === "suppress" ? { suppressApprovalForTools: [tool.name] } : {}),
  }
}

// ---------------------------------------------------------------------------
// One call through one rail, observed from the outside.

interface Call {
  rail: Rail
  sendOptions: Json
  toolName: string
  input: Json
  /** What the stub doom guard answers: true = "this call is a runaway repeat". */
  doom?: boolean
  /** A real guard instead of the stub (sequence cases). */
  doomGuard?: { check(toolName: string, input: unknown): "ask" | null; reset(): void }
  signal?: AbortSignal
  /** Extra Agent SDK `canUseTool` context fields. */
  ctx?: Json
  aliases?: Map<string, string>
  /** The renderer's reply to a permission request; defaults to an unmodified allow. */
  answer?: (input: Json) => Json | "abort"
  /** Mutate the options after the gate was built, before the call. */
  mutate?: (sendOptions: Json) => void
  log?: (level: string, message: string) => void
}

interface Observation {
  outcome: string
  frames: Json[]
  entries: Json[]
  doomCalls: number
  pendingAfter: number
}

const MISSING = Symbol("missing")

async function observe(call: Call): Promise<Observation> {
  const frames: Json[] = []
  const pending = new Map<string, Json & { resolve: (answer: unknown) => void }>()
  let doomCalls = 0
  const stubGuard = {
    check: () => {
      doomCalls += 1
      return call.doom ? ("ask" as const) : null
    },
    reset() {},
  }
  const doomGuard = call.doomGuard
    ? {
        check: (toolName: string, input: unknown) => {
          doomCalls += 1
          return call.doomGuard!.check(toolName, input)
        },
        reset() {},
      }
    : stubGuard
  const controller = new AbortController()
  const signal = call.signal ?? controller.signal
  const emit = (frame: Json) => frames.push(frame)

  let settled: Promise<unknown> | typeof MISSING = MISSING
  let syncError: unknown = MISSING
  if (call.rail === "sdk") {
    const canUseTool = createAnthropicCanUseTool({
      sendOptions: call.sendOptions,
      sessionId: "s1",
      emit,
      log: call.log ?? (() => {}),
      pendingApprovals: pending,
      pluginToolNameAliases: call.aliases ?? new Map(),
      doomGuard,
    })
    call.mutate?.(call.sendOptions)
    try {
      settled = canUseTool(call.toolName, call.input, { toolUseID: "tu-1", signal, ...call.ctx })
    } catch (error) {
      syncError = error
    }
  } else {
    const gate = createToolPermissionGate({
      emit,
      sessionId: "s1",
      pendingApprovals: call.rail === "ai" ? pending : undefined,
      sendOptions: call.sendOptions,
      doomGuard,
    })
    call.mutate?.(call.sendOptions)
    settled = gate(call.toolName, call.input, signal)
  }

  const entries = [...pending.values()].map(({ resolve: _resolve, ...rest }) => rest)
  for (const [requestId, entry] of [...pending]) {
    const reply = (call.answer ?? ((input) => ({ behavior: "allow", updatedInput: input })))(
      call.input
    )
    if (reply === "abort") {
      controller.abort()
      continue
    }
    // The host's permission_response handler: forget the waiter, then settle it.
    pending.delete(requestId)
    entry.resolve(reply)
  }

  let outcome: string
  if (syncError !== MISSING) outcome = `throw ${messageOf(syncError)}`
  else {
    try {
      const value = await (settled as Promise<unknown>)
      outcome = describeValue(value, call.input)
    } catch (error) {
      outcome = `reject ${messageOf(error)}`
    }
  }
  return { outcome, frames, entries, doomCalls, pendingAfter: pending.size }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : `non-error ${JSON.stringify(error)}`
}

function describeValue(value: unknown, input: Json): string {
  if (value === input) return "input"
  return describe(value, input)
}

/** Key-ordered rendering that keeps `undefined` members and marks the original input. */
function describe(value: unknown, input?: Json): string {
  if (value === undefined) return "undefined"
  if (input !== undefined && value === input) return "<input>"
  if (Array.isArray(value)) return `[${value.map((v) => describe(v, input)).join(",")}]`
  if (value && typeof value === "object") {
    const inner = Object.entries(value as Json)
      .map(([k, v]) => `${k}:${describe(v, input)}`)
      .join(",")
    return `{${inner}}`
  }
  if (typeof value === "function") return "fn"
  return JSON.stringify(value)
}

function normalize(text: string): string {
  return text.split(ROOT).join("<root>").split(OUTSIDE).join("<outside>")
}

// ---------------------------------------------------------------------------
// Grid encoding: one short code per cell, messages in a keyed table.

const messages = new Map<string, string>()

function messageId(message: string): string {
  const id = createHash("sha1").update(message).digest("hex").slice(0, 4)
  const seen = messages.get(id)
  assert.ok(seen === undefined || seen === message, `message id collision: ${id}`)
  messages.set(id, message)
  return id
}

/**
 * `A` allowed with the input unchanged, `x<id>` denied with message <id>,
 * `t<id>` threw synchronously with message <id>. A `Q` prefix: the call asked
 * the renderer first (answered with an unmodified allow). A `.` suffix: the
 * doom guard was not consulted.
 */
function cellCode(call: Call, obs: Observation): string {
  const asked = obs.frames.some((f) => f.type === "permission_request")
  let core: string
  // The tool's own name inside a message becomes <tool>, so one message id
  // covers every tool; a message naming a DIFFERENT tool keeps it verbatim.
  const name = call.toolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const o = normalize(obs.outcome).replace(
    new RegExp(`(?<![\\w:.-])${name}(?![\\w:.-])`, "g"),
    "<tool>"
  )
  if (o === "input" || o === '{behavior:"allow",updatedInput:<input>}') core = "A"
  else if (o.startsWith("reject ")) core = `x${messageId(o.slice("reject ".length))}`
  else if (o.startsWith("throw ")) core = `t${messageId(o.slice("throw ".length))}`
  else {
    const deny = /^\{behavior:"deny",message:(".*")\}$/.exec(o)
    core = deny ? `x${messageId(JSON.parse(deny[1]!) as string)}` : `?${o}`
  }
  const doom = obs.doomCalls === 0 ? "." : obs.doomCalls === 1 ? "" : `!${obs.doomCalls}`
  assert.equal(obs.pendingAfter, 0, `${call.rail} ${call.toolName}: a waiter was left behind`)
  return `${asked ? "Q" : ""}${core}${doom}`
}

async function gridLines(): Promise<string[]> {
  const lines: string[] = []
  for (const rail of RAILS) {
    for (const tool of TOOLS) {
      for (const conf of tool.paths ? CONFS : (["off"] as const)) {
        for (const overlay of OVERLAYS) {
          const codes: string[] = []
          for (const mode of MODES) {
            const pair: string[] = []
            for (const doom of [false, true]) {
              const call: Call = {
                rail,
                sendOptions: sendOptionsFor(tool, conf, overlay, mode),
                toolName: tool.name,
                input: tool.input(conf),
                doom,
              }
              pair.push(cellCode(call, await observe(call)))
            }
            codes.push(pair.join("/").padEnd(15))
          }
          const key = `${rail.padEnd(12)}${tool.id.padEnd(17)}${conf.padEnd(5)}${overlay.padEnd(12)}`
          lines.push(`${key}${codes.join(" ").trimEnd()}`)
        }
      }
    }
  }
  return lines
}

/**
 * Invariants the grid leaves out to stay small: `auto` decides exactly like
 * `default`, and an always-allow grant exactly like a suppress entry.
 */
async function equivalenceFailures(): Promise<string[]> {
  const failures: string[] = []
  for (const rail of RAILS) {
    for (const tool of TOOLS) {
      for (const conf of tool.paths ? CONFS : (["off"] as const)) {
        for (const doom of [false, true]) {
          const base = (overlay: Overlay, mode: string): Call => ({
            rail,
            sendOptions: sendOptionsFor(tool, conf, overlay, mode),
            toolName: tool.name,
            input: tool.input(conf),
            doom,
          })
          const pairs: [Call, Call, string][] = []
          for (const overlay of OVERLAYS) {
            pairs.push([base(overlay, "auto"), base(overlay, "default"), `auto≠default ${overlay}`])
          }
          for (const mode of MODES) {
            const always = base("none", mode)
            always.sendOptions.alwaysAllowTools = [tool.name]
            pairs.push([always, base("suppress", mode), `alwaysAllow≠suppress ${mode}`])
          }
          for (const [a, b, what] of pairs) {
            const [oa, ob] = [await observe(a), await observe(b)]
            const [ca, cb] = [cellCode(a, oa), cellCode(b, ob)]
            if (ca !== cb)
              failures.push(`${rail} ${tool.id} ${conf} doom=${doom} ${what}: ${ca} vs ${cb}`)
          }
        }
      }
    }
  }
  return failures
}

// ---------------------------------------------------------------------------
// Frames and pending entries, per rail and tool.

const FRAME_TOOLS: ReadonlySet<string> = new Set(["b.write", "p.other", "f.mcp", "n.Write"])

async function frameLines(): Promise<string[]> {
  const lines: string[] = []
  for (const rail of ["sdk", "ai"] as const) {
    for (const remote of [false, true]) {
      // One tool per class; the frame builders never look at the class, and
      // the remote context is tool-independent.
      for (const tool of TOOLS) {
        if (!FRAME_TOOLS.has(tool.id) || (remote && tool.id !== "b.write")) continue
        const sendOptions = sendOptionsFor(tool, "off", "none", "default")
        if (remote) sendOptions.remoteExecutionContext = { hostId: "h1", kind: "ssh" }
        const input = tool.input("off")
        const obs = await observe({
          rail,
          sendOptions,
          toolName: tool.name,
          input,
          ctx: {
            title: "Title",
            displayName: "Display",
            description: "Desc",
            decisionReason: "reason",
            suggestions: [{ type: "addRules" }],
            defaultToNo: false,
          },
        })
        const frames = obs.frames.map((f) => describe({ ...f, requestId: "<id>" }, input))
        const entries = obs.entries.map((e) => describe(e, input))
        lines.push(
          normalize(
            `${rail} remote=${remote} ${tool.id}\n  frames ${frames.join(" ")}\n  entries ${entries.join(" ")}\n  outcome ${obs.outcome}`
          )
        )
      }
    }
  }
  return lines
}

// ---------------------------------------------------------------------------
// Named edge cases: interrupts, PII, the sandbox scope, approval replies,
// liveness of the options, throwing policy inputs, doom sequences, aliases.

function aborted(): AbortSignal {
  const c = new AbortController()
  c.abort()
  return c.signal
}

const WRITE = TOOLS.find((t) => t.id === "b.write")!
const READ = TOOLS.find((t) => t.id === "b.read")!
const ASK_USER = TOOLS.find((t) => t.id === "p.ask_user")!

function baseCall(rail: Rail, tool: ToolCase, extra: Partial<Call> = {}): Call {
  return {
    rail,
    sendOptions: sendOptionsFor(tool, "in", "none", "default"),
    toolName: tool.name,
    input: tool.input("in"),
    ...extra,
  }
}

/** A request frame's full shape is pinned under [frames]; cases name its tool only. */
function render(obs: Observation, input: Json): string {
  const frames = obs.frames.map((f) =>
    f.type === "permission_request"
      ? `request(${String(f.toolName)})`
      : describe({ ...f, requestId: "<id>" }, input)
  )
  return normalize(
    `${obs.outcome} | frames ${frames.length ? frames.join(" ") : "-"} | doom ${obs.doomCalls}`
  )
}

async function caseLines(): Promise<string[]> {
  const lines: string[] = []
  const add = async (name: string, call: Call) => {
    lines.push(`${name.padEnd(46)}${render(await observe(call), call.input)}`)
  }

  for (const rail of RAILS) {
    for (const tool of [READ, WRITE, ASK_USER]) {
      await add(`${rail} pre-aborted ${tool.id}`, baseCall(rail, tool, { signal: aborted() }))
    }
    const pii = { file_path: target("in"), content: "mail alice@example.com" }
    await add(`${rail} pii-input b.write`, { ...baseCall(rail, WRITE), input: pii })
    await add(`${rail} pii-input p.ask_user`, {
      ...baseCall(rail, ASK_USER),
      input: { question: "mail alice@example.com" },
    })
    for (const tool of [READ, WRITE]) {
      const call = baseCall(rail, tool)
      call.sendOptions.builtinProcessSandbox = { writableRoots: [ROOT] }
      call.input = tool.input("out")
      await add(`${rail} sandbox-scope outside ${tool.id}`, call)
      const inside = baseCall(rail, tool)
      inside.sendOptions.builtinProcessSandbox = { writableRoots: [ROOT] }
      await add(`${rail} sandbox-scope inside ${tool.id}`, inside)
    }
  }

  for (const rail of ["sdk", "ai"] as const) {
    const replies: [string, (input: Json) => Json | "abort"][] = [
      ["allow-unmodified", (input) => ({ behavior: "allow", updatedInput: input })],
      [
        "allow-updated",
        (input) => ({ behavior: "allow", updatedInput: { ...input, content: "y" } }),
      ],
      ["allow-no-input", () => ({ behavior: "allow" })],
      [
        "allow-updated-credential",
        (input) => ({ behavior: "allow", updatedInput: { ...input, file_path: target("cred") } }),
      ],
      [
        "allow-updated-pii",
        (input) => ({ behavior: "allow", updatedInput: { ...input, content: "bob@example.com" } }),
      ],
      ["deny-message", () => ({ behavior: "deny", message: "nope" })],
      ["deny-bare", () => ({ behavior: "deny" })],
      ["abort-while-pending", () => "abort"],
    ]
    for (const [name, answer] of replies) {
      await add(`${rail} reply ${name}`, baseCall(rail, WRITE, { answer }))
    }

    // Abort listener hygiene: a settled approval must detach from the signal.
    const controller = new AbortController()
    let added = 0
    let removed = 0
    const add0 = controller.signal.addEventListener.bind(controller.signal)
    const remove0 = controller.signal.removeEventListener.bind(controller.signal)
    controller.signal.addEventListener = ((...args: Parameters<typeof add0>) => {
      added += 1
      return add0(...args)
    }) as typeof add0
    controller.signal.removeEventListener = ((...args: Parameters<typeof remove0>) => {
      removed += 1
      return remove0(...args)
    }) as typeof remove0
    await observe(baseCall(rail, WRITE, { signal: controller.signal }))
    lines.push(`${`${rail} abort-listener`.padEnd(46)}added ${added} removed ${removed}`)

    // Options read live vs captured when the gate was built.
    await add(`${rail} live mode default→plan b.write`, {
      ...baseCall(rail, WRITE),
      mutate: (o) => {
        o.permissionMode = "plan"
      },
    })
    await add(`${rail} live ruleset added b.write`, {
      ...baseCall(rail, WRITE),
      mutate: (o) => {
        o.permissionRuleset = { [WRITE.name]: "allow" }
      },
    })
    await add(`${rail} live suppress added b.write`, {
      ...baseCall(rail, WRITE),
      mutate: (o) => {
        o.suppressApprovalForTools = [WRITE.name]
      },
    })
    await add(`${rail} live alwaysAllow added b.write`, {
      ...baseCall(rail, WRITE),
      mutate: (o) => {
        o.alwaysAllowTools = [WRITE.name]
      },
    })

    // Policy inputs that throw when read.
    const throwingRules = new Proxy(
      {},
      {
        get() {
          throw new Error("ruleset exploded")
        },
        ownKeys() {
          throw new Error("ruleset exploded")
        },
      }
    )
    await add(`${rail} throwing ruleset b.write`, {
      ...baseCall(rail, WRITE),
      sendOptions: {
        ...sendOptionsFor(WRITE, "in", "none", "default"),
        permissionRuleset: throwingRules,
      },
    })
    const throwingConfinement = {
      get enabled(): boolean {
        throw new Error("confinement exploded")
      },
      roots: [ROOT],
    }
    await add(`${rail} throwing confinement b.write`, {
      ...baseCall(rail, WRITE),
      sendOptions: {
        ...sendOptionsFor(WRITE, "off", "none", "default"),
        confinement: throwingConfinement,
      },
    })

    // A real doom guard: the third identical call asks even with a grant.
    for (const [label, mode] of [
      ["suppress", "default"],
      ["plan", "plan"],
    ] as const) {
      const guard = createDoomLoopGuard()
      const outcomes: string[] = []
      for (let i = 0; i < 4; i++) {
        const call = baseCall(rail, READ, { doomGuard: guard })
        call.sendOptions = sendOptionsFor(READ, "in", "suppress", mode)
        outcomes.push(cellCode(call, await observe(call)))
      }
      lines.push(`${`${rail} doom-sequence ${label} b.read`.padEnd(46)}${outcomes.join(" ")}`)
    }
  }

  // Agent SDK only: plugin aliases, the verbose trace, and delegated approval.
  const aliases = new Map([["notes_search", "notes:search"]])
  await add("sdk alias restored for the ruleset", {
    rail: "sdk",
    sendOptions: {
      permissionMode: "default",
      cwd: ROOT,
      permissionRuleset: { "mcp__cognia-plugin-tools__notes:search": "allow" },
    },
    toolName: "mcp__cognia-plugin-tools__notes_search",
    input: { query: "q" },
    aliases,
  })
  await add("sdk alias restored in the frame", {
    rail: "sdk",
    sendOptions: { permissionMode: "default", cwd: ROOT },
    toolName: "mcp__cognia-plugin-tools__notes_search",
    input: { query: "q" },
    aliases,
  })

  const logs: string[] = []
  const previous = process.env.COGNIA_SIDECAR_VERBOSE
  process.env.COGNIA_SIDECAR_VERBOSE = "1"
  try {
    await observe(
      baseCall("sdk", WRITE, { log: (level, message) => logs.push(`${level} ${message}`) })
    )
  } finally {
    if (previous === undefined) delete process.env.COGNIA_SIDECAR_VERBOSE
    else process.env.COGNIA_SIDECAR_VERBOSE = previous
  }
  lines.push(
    `${"sdk verbose trace".padEnd(46)}${logs.map((l) => l.replace(/requestId=\S+/, "requestId=<id>")).join(" ; ")}`
  )

  const delegated = [
    ["plan write", { permissionMode: "plan" }, "mcp__cognia-tools__write", { file_path: "/w/a" }],
    ["default read", { permissionMode: "default" }, "Read", { file_path: "/w/a" }],
    ["pii read", { permissionMode: "default" }, "Read", { content: "carol@example.com" }],
    [
      "ruleset deny",
      { permissionMode: "default", permissionRuleset: { Read: "deny" } },
      "Read",
      { file_path: "/w/a" },
    ],
  ] as const
  for (const [name, sendOptions, toolName, toolInput] of delegated) {
    const options = enforceAnthropicPermissionChannel(
      { permissionPromptToolName: "mcp__permission__review" },
      { ...sendOptions, cwd: ROOT }
    )
    const guard = options.hooks.PreToolUse.at(-1).hooks[0]
    const out = await guard({ tool_name: toolName, tool_input: toolInput }, "id", {
      signal: new AbortController().signal,
    })
    lines.push(`${`sdk delegated ${name}`.padEnd(46)}${normalize(describe(out))}`)
  }
  return lines
}

// ---------------------------------------------------------------------------

test("P1: both permission ladders match the golden decision grid, frames and edge cases", async () => {
  const grid = await gridLines()
  const frames = await frameLines()
  const cases = await caseLines()
  const table = [...messages].sort(([a], [b]) => a.localeCompare(b))
  const actual = [
    "# P1 permission-ladder pins. Generated by src/policy/permission/ladder.pins.test.ts;",
    "# regenerate with UPDATE_GOLDEN=1 only for an intended behaviour change.",
    "#",
    "# Grid columns: mode " + MODES.join(" | ") + ", each as <doom off>/<doom on>.",
    "# Codes: A allowed, input unchanged. x<id> denied with message <id>. t<id> threw",
    "# synchronously. Q prefix: asked the renderer first (it allowed). '.' suffix: the doom",
    "# guard was not consulted. Rails: sdk = Claude Agent SDK canUseTool, ai = ai-sdk gate,",
    "# ai-headless = ai-sdk gate with no approval channel.",
    "",
    "[messages]",
    ...table.map(([id, message]) => `${id} ${normalize(message)}`),
    "",
    "[grid]",
    ...grid,
    "",
    "[frames]",
    ...frames,
    "",
    "[cases]",
    ...cases,
    "",
  ].join("\n")

  if (process.env.UPDATE_GOLDEN === "1") fs.writeFileSync(GOLDEN, actual)
  const expected = fs.readFileSync(GOLDEN, "utf8")
  if (actual !== expected) {
    const a = actual.split("\n")
    const e = expected.split("\n")
    const diffs: string[] = []
    for (let i = 0; i < Math.max(a.length, e.length) && diffs.length < 40; i++) {
      if (a[i] !== e[i]) diffs.push(`line ${i + 1}\n  golden: ${e[i]}\n  actual: ${a[i]}`)
    }
    assert.fail(`permission ladder drifted from the golden:\n${diffs.join("\n")}`)
  }
})

test("P1: auto decides like default, and alwaysAllow like a suppress entry, on every rail", async () => {
  assert.deepEqual(await equivalenceFailures(), [])
})
