/**
 * ADR-0028 Phase 4.5 — `cognia-sandboxed-tools` plugin.
 *
 * Registers four MCP plugin tools — `sandbox_bash`, `sandbox_edit`,
 * `sandbox_write`, `sandbox_text_editor` — that REPLACE the SDK builtin
 * `Bash` / `Edit` / `Write` and the Anthropic native `text_editor` when
 * the active session has sandbox enabled. Every call forwards through the
 * existing `plugin_tool_exec` IPC to the renderer, which dispatches to
 * the Tauri `sandbox_exec` command. The Rust side derives a
 * `SandboxPolicy` from `(tool, request)` and runs the command under the
 * per-platform backend (`sandbox-exec` / `bwrap` / `windows-codex-vendor-
 * pending` SetupRequired stub).
 *
 * `lib/claude/build-options.ts` (Phase 4.5b in the same commit) is what
 * actually gates the builtin replacement: when sandbox is enabled it
 * adds `Bash` / `Edit` / `Write` to `opts.disallowedTools`, filters
 * native `text_editor` out of `opts.anthropicTools`, and surfaces the
 * four `sandbox_*` plugin tools via `opts.pluginTools` so the model
 * picks them up instead.
 *
 * Strict mode (ADR-0028): when the sandbox is unavailable (Windows
 * vendor pending, bwrap missing, etc.) the backend returns
 * `SetupRequired` / `Unavailable` and the plugin surfaces the error
 * verbatim — no silent fallback to unsandboxed execution.
 */

import {
  definePlugin,
  definePluginManifest,
  definePluginTool,
  type PluginContext,
  type PluginToolContext,
  type PluginToolRegistration,
} from "@cognia/plugin-sdk"
import type { MicrovmExecPayload } from "@cognia/plugin-sdk/api/sandbox"
import { SandboxRuntimeError } from "@cognia/plugin-sdk/api/sandbox"
import manifestJson from "../plugin.json"
import { applyInsert, applyStrReplace, sliceViewRange } from "./edit-ops"

type SandboxAPI = PluginContext["sandbox"]

const TOOL_SANDBOX_BASH = "sandbox_bash"
const TOOL_SANDBOX_EDIT = "sandbox_edit"
const TOOL_SANDBOX_WRITE = "sandbox_write"
const TOOL_SANDBOX_TEXT_EDITOR = "sandbox_text_editor"

/**
 * Tool budgets. A registered tool without `timeoutMs` is cut by the host at
 * 30 s, far below a real build or test run, so each tool declares its own and
 * the per-call `timeoutSeconds` the model passes is clamped under it: the
 * sandbox's own `timed_out` result must win the race against the host budget,
 * never the other way round.
 *
 * `sandbox_bash` runs one command: its budget is the 600 s host ceiling
 * (`MAX_TOOL_TIMEOUT_MS`) and a command may use all of it.
 *
 * The file tools run up to TWO sandbox execs per call (read, then write), so
 * a per-exec cap of 120 s keeps both inside the 300 s tool budget.
 */
export const SANDBOX_BASH_TIMEOUT_MS = 600_000
export const SANDBOX_BASH_MAX_TIMEOUT_SECONDS = SANDBOX_BASH_TIMEOUT_MS / 1000
const SANDBOX_BASH_DEFAULT_TIMEOUT_SECONDS = 300
export const SANDBOX_FILE_TOOL_TIMEOUT_MS = 300_000
export const SANDBOX_FILE_TOOL_MAX_TIMEOUT_SECONDS = 120
const SANDBOX_FILE_TOOL_DEFAULT_TIMEOUT_SECONDS = 60

const SANDBOX_BASH_DESCRIPTION =
  "Execute a shell command inside an OS-level sandbox (sandbox-exec on macOS, bwrap on " +
  "Linux, or the session's E2B microVM when that tier is active). Reads / writes are " +
  "confined to the writable / readable paths the caller supplies; network is denied " +
  "unless explicitly opted in. The command is killed after timeoutSeconds (default " +
  `${SANDBOX_BASH_DEFAULT_TIMEOUT_SECONDS}, at most ${SANDBOX_BASH_MAX_TIMEOUT_SECONDS}). ` +
  "Returns stdout, stderr, exit code, and a `timed_out` flag. Use this instead of the " +
  "unsandboxed Bash tool."

const SANDBOX_EDIT_DESCRIPTION =
  "Edit an existing file inside the sandbox. Only the single file at `path` is writable; " +
  "nothing else on the filesystem is. Network always denied. Use this instead of the " +
  "unsandboxed Edit tool."

const SANDBOX_WRITE_DESCRIPTION =
  "Create or overwrite a file inside the sandbox. Only the single file at `path` is " +
  "writable. Use this instead of the unsandboxed Write tool."

const SANDBOX_TEXT_EDITOR_DESCRIPTION =
  "Anthropic-style text editor (view / create / str_replace / insert) executed inside " +
  "the sandbox. The read and write both run under the OS sandbox, confined to the " +
  "target path. Replaces the native text_editor tool when sandbox mode is enabled."

const FILE_TOOL_TIMEOUT_SCHEMA = {
  type: "integer",
  minimum: 1,
  maximum: SANDBOX_FILE_TOOL_MAX_TIMEOUT_SECONDS,
  description:
    `Per-step timeout in seconds (default ${SANDBOX_FILE_TOOL_DEFAULT_TIMEOUT_SECONDS}, ` +
    `at most ${SANDBOX_FILE_TOOL_MAX_TIMEOUT_SECONDS}).`,
}

const READABLE_SCHEMA = {
  type: "array",
  items: { type: "string" },
  description: "Extra read-only paths.",
}

const SANDBOX_BASH_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["command", "cwd"],
  properties: {
    command: { type: "string", description: "Shell command to run via bash -c." },
    cwd: {
      type: "string",
      description: "Working directory the shell starts in. Must be inside writable.",
    },
    writable: {
      type: "array",
      items: { type: "string" },
      description: "Writable directory paths (incl. cwd).",
    },
    readable: {
      type: "array",
      items: { type: "string" },
      description: "Read-only paths beyond the standard system dirs.",
    },
    network: {
      type: "string",
      enum: ["off", "on", "allowlist"],
      description: "Network policy. Default off.",
    },
    networkHosts: {
      type: "array",
      items: { type: "string" },
      description: "Required when network=allowlist.",
    },
    timeoutSeconds: {
      type: "integer",
      minimum: 1,
      maximum: SANDBOX_BASH_MAX_TIMEOUT_SECONDS,
      description:
        `Kill the command after this many seconds (default ` +
        `${SANDBOX_BASH_DEFAULT_TIMEOUT_SECONDS}, at most ${SANDBOX_BASH_MAX_TIMEOUT_SECONDS}).`,
    },
    maxCpuSeconds: { type: "integer", minimum: 0 },
    maxMemoryMb: { type: "integer", minimum: 0 },
  },
}

const SANDBOX_EDIT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["path", "oldString", "newString"],
  properties: {
    path: { type: "string", description: "Absolute path of the file to edit." },
    oldString: {
      type: "string",
      description: "Exact text to replace. Must be unique in the file unless replaceAll is set.",
    },
    newString: { type: "string", description: "Replacement text." },
    replaceAll: {
      type: "boolean",
      description: "Replace every occurrence instead of requiring a unique match.",
    },
    readable: READABLE_SCHEMA,
    timeoutSeconds: FILE_TOOL_TIMEOUT_SCHEMA,
  },
}

const SANDBOX_WRITE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["path", "content"],
  properties: {
    path: { type: "string", description: "Absolute path of the file to create or overwrite." },
    content: { type: "string", description: "Full file content to write." },
    readable: READABLE_SCHEMA,
    timeoutSeconds: FILE_TOOL_TIMEOUT_SCHEMA,
  },
}

const SANDBOX_TEXT_EDITOR_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["command", "path"],
  properties: {
    command: {
      type: "string",
      enum: ["view", "create", "str_replace", "insert"],
      description: "Editor sub-command.",
    },
    path: { type: "string", description: "Absolute path of the target file." },
    fileText: { type: "string", description: "For create: the full file content." },
    oldStr: { type: "string", description: "For str_replace: the unique text to replace." },
    newStr: { type: "string", description: "For str_replace: the replacement text." },
    insertLine: {
      type: "integer",
      minimum: 0,
      description: "For insert: 1-based line to insert AFTER (0 = before the first line).",
    },
    insertText: { type: "string", description: "For insert: the text to insert." },
    viewRange: {
      type: "array",
      items: { type: "integer" },
      minItems: 2,
      maxItems: 2,
      description: "For view: [start, end] 1-based inclusive line range (end -1 = end of file).",
    },
    readable: READABLE_SCHEMA,
    timeoutSeconds: FILE_TOOL_TIMEOUT_SCHEMA,
  },
}

type NetworkMode = "off" | "on" | "allowlist"
type TextEditorCommand = "view" | "create" | "str_replace" | "insert"

interface BashCallInputs {
  command: string
  cwd: string
  writable: string[]
  readable: string[]
  network: NetworkMode
  networkHosts: string[]
  timeoutSeconds: number
  maxCpuSeconds: number
  maxMemoryMb: number
}

/** Tool names whose `policy_for` maps to a single-file write scope. */
type FileToolName =
  typeof TOOL_SANDBOX_EDIT | typeof TOOL_SANDBOX_WRITE | typeof TOOL_SANDBOX_TEXT_EDITOR

interface FileCallBase {
  path: string
  readable: string[]
  timeoutSeconds: number
}

interface WriteCallInputs extends FileCallBase {
  content: string
}

interface EditCallInputs extends FileCallBase {
  oldString: string
  newString: string
  replaceAll: boolean
}

interface TextEditorCallInputs extends FileCallBase {
  command: TextEditorCommand
  fileText: string
  oldStr: string
  newStr: string
  insertLine: number
  insertText: string
  viewRange: [number, number] | null
}

interface SandboxResultShape {
  exit_code: number
  stdout: string
  stderr: string
  duration: number
  timed_out: boolean
  stdout_truncated?: boolean
  stderr_truncated?: boolean
}

// ---------------------------------------------------------------------------
// Argument readers. The model-facing schemas are advisory — nothing between
// the model and `execute` is guaranteed to enforce them — so every value is
// re-checked here. Only DECLARED keys are read: an undeclared key (a stray
// `env`, say) is ignored rather than honoured, matching
// `additionalProperties: false`.
// ---------------------------------------------------------------------------

function requireString(args: Record<string, unknown>, key: string, tool: string): string {
  const value = args[key]
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${tool}: \`${key}\` is required and must be a non-empty string`)
  }
  return value
}

function optionalString(args: Record<string, unknown>, key: string, tool: string): string {
  const value = args[key]
  if (value === undefined || value === null) return ""
  if (typeof value !== "string") throw new Error(`${tool}: \`${key}\` must be a string`)
  return value
}

function stringList(args: Record<string, unknown>, key: string, tool: string): string[] {
  const value = args[key]
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${tool}: \`${key}\` must be an array of strings`)
  }
  return value as string[]
}

function nonNegativeInteger(args: Record<string, unknown>, key: string, tool: string): number {
  const value = args[key]
  if (value === undefined || value === null) return 0
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${tool}: \`${key}\` must be a non-negative integer`)
  }
  return value
}

/**
 * Resolve the per-exec timeout: absent → the tool default; otherwise clamped
 * into `[1, max]`. `0` is NOT "no timeout" here — the sandbox backend reads a
 * non-positive timeout as unbounded, which would always lose to the host's
 * tool budget and surface as a generic timeout instead of `timed_out: true`.
 */
export function boundTimeoutSeconds(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(1, Math.floor(value)))
}

function readNetwork(args: Record<string, unknown>): NetworkMode {
  const value = args.network
  if (value === undefined || value === null) return "off"
  if (value === "off" || value === "on" || value === "allowlist") return value
  throw new Error(`${TOOL_SANDBOX_BASH}: \`network\` must be one of off, on, allowlist`)
}

function readBashInputs(args: Record<string, unknown>): BashCallInputs {
  return {
    command: requireString(args, "command", TOOL_SANDBOX_BASH),
    cwd: requireString(args, "cwd", TOOL_SANDBOX_BASH),
    writable: stringList(args, "writable", TOOL_SANDBOX_BASH),
    readable: stringList(args, "readable", TOOL_SANDBOX_BASH),
    network: readNetwork(args),
    networkHosts: stringList(args, "networkHosts", TOOL_SANDBOX_BASH),
    timeoutSeconds: boundTimeoutSeconds(
      args.timeoutSeconds,
      SANDBOX_BASH_DEFAULT_TIMEOUT_SECONDS,
      SANDBOX_BASH_MAX_TIMEOUT_SECONDS
    ),
    maxCpuSeconds: nonNegativeInteger(args, "maxCpuSeconds", TOOL_SANDBOX_BASH),
    maxMemoryMb: nonNegativeInteger(args, "maxMemoryMb", TOOL_SANDBOX_BASH),
  }
}

function readFileBase(args: Record<string, unknown>, tool: FileToolName): FileCallBase {
  return {
    path: requireString(args, "path", tool),
    readable: stringList(args, "readable", tool),
    timeoutSeconds: boundTimeoutSeconds(
      args.timeoutSeconds,
      SANDBOX_FILE_TOOL_DEFAULT_TIMEOUT_SECONDS,
      SANDBOX_FILE_TOOL_MAX_TIMEOUT_SECONDS
    ),
  }
}

function readWriteInputs(args: Record<string, unknown>): WriteCallInputs {
  const content = args.content
  if (typeof content !== "string") {
    throw new Error(`${TOOL_SANDBOX_WRITE}: \`content\` is required and must be a string`)
  }
  return { ...readFileBase(args, TOOL_SANDBOX_WRITE), content }
}

function readEditInputs(args: Record<string, unknown>): EditCallInputs {
  const newString = args.newString
  if (typeof newString !== "string") {
    throw new Error(`${TOOL_SANDBOX_EDIT}: \`newString\` is required and must be a string`)
  }
  return {
    ...readFileBase(args, TOOL_SANDBOX_EDIT),
    oldString: requireString(args, "oldString", TOOL_SANDBOX_EDIT),
    newString,
    replaceAll: args.replaceAll === true,
  }
}

function readViewRange(value: unknown): [number, number] | null {
  if (value === undefined || value === null) return null
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !value.every((n) => typeof n === "number" && Number.isInteger(n))
  ) {
    throw new Error(`${TOOL_SANDBOX_TEXT_EDITOR}: \`viewRange\` must be [start, end] integers`)
  }
  return [value[0] as number, value[1] as number]
}

function readTextEditorInputs(args: Record<string, unknown>): TextEditorCallInputs {
  const tool = TOOL_SANDBOX_TEXT_EDITOR
  const command = args.command
  if (
    command !== "view" &&
    command !== "create" &&
    command !== "str_replace" &&
    command !== "insert"
  ) {
    throw new Error(`${tool}: unknown command ${JSON.stringify(command)}`)
  }
  return {
    ...readFileBase(args, tool),
    command,
    fileText: optionalString(args, "fileText", tool),
    oldStr: optionalString(args, "oldStr", tool),
    newStr: optionalString(args, "newStr", tool),
    insertLine: nonNegativeInteger(args, "insertLine", tool),
    insertText: optionalString(args, "insertText", tool),
    viewRange: readViewRange(args.viewRange),
  }
}

// ---------------------------------------------------------------------------
// Execution. Every function takes the plugin's own `ctx.sandbox` explicitly —
// the tools close over it at registration, so there is no module-level
// "context unavailable" state to fall into.
// ---------------------------------------------------------------------------

/**
 * `ctx.sandbox.execute` takes no AbortSignal, so an in-flight exec cannot be
 * cancelled from here (it ends at its own `timeout`). What the plugin CAN do
 * is not start the next exec — a read-then-write edit whose caller already
 * gave up must not go on to write the file.
 */
function throwIfAborted(callCtx: PluginToolContext): void {
  if (callCtx.signal?.aborted) {
    throw new Error("The sandboxed call was cancelled before it ran.")
  }
}

/**
 * Dispatch a `sandbox_exec` payload through the placement bound to this call.
 * The host resolves the tier (OS sandbox or E2B microVM) from the runtime
 * reference; strict mode (ADR-0028) means a microVM placement with no adapter
 * throws there — no silent fallback to the OS tier.
 */
async function dispatchSandbox(
  sandbox: SandboxAPI,
  payload: MicrovmExecPayload,
  callCtx: PluginToolContext
): Promise<SandboxResultShape> {
  throwIfAborted(callCtx)
  return sandbox.execute(requireRuntimeRef(sandbox, callCtx), payload)
}

async function execBash(
  sandbox: SandboxAPI,
  args: BashCallInputs,
  callCtx: PluginToolContext
): Promise<SandboxResultShape> {
  const cwd = args.cwd
  assertPathUnderCeiling(sandbox, cwd, callCtx, "working directory")
  const runtimeRef = requireRuntimeRef(sandbox, callCtx)
  const explicitWritable = args.writable.length > 0 ? args.writable : null
  const narrowedExplicitWritable = explicitWritable
    ? sandbox.clampRequest(runtimeRef, {
        writable: explicitWritable,
        readable: [],
        targetFiles: [],
        maxCpuSeconds: 0,
        maxMemoryMb: 0,
        network: "off",
        networkHosts: [],
      }).writable
    : []
  const writable = explicitWritable
    ? Array.from(new Set([cwd, ...narrowedExplicitWritable]))
    : [cwd]
  // Clamp the model-supplied resource caps + network down to the per-session
  // ceiling (character override beats the app default). The model cannot widen
  // past the configured policy because this is the only path to `sandbox_exec`.
  const request = sandbox.clampRequest(runtimeRef, {
    writable,
    readable: args.readable,
    targetFiles: [],
    maxCpuSeconds: args.maxCpuSeconds,
    maxMemoryMb: args.maxMemoryMb,
    network: args.network,
    networkHosts: args.networkHosts,
  })
  return dispatchSandbox(
    sandbox,
    {
      tool: TOOL_SANDBOX_BASH,
      command: {
        argv: ["bash", "-c", args.command],
        cwd,
        env: {},
        stdin: null,
        timeout: args.timeoutSeconds,
      },
      request,
    },
    callCtx
  )
}

/**
 * Enforce the per-session writable-root ceiling on a single-file write target.
 * Bash narrows its writable set via `clampPolicyRequest`; the file tools take a
 * single `path` directly, so they guard here. No ceiling configured → no-op
 * (the always-on Rust floor still rejects system / app-data targets).
 */
function assertPathUnderCeiling(
  sandbox: SandboxAPI,
  path: string,
  callCtx: PluginToolContext,
  label = "path"
): void {
  sandbox.assertWritablePath(requireRuntimeRef(sandbox, callCtx), path, label)
}

/**
 * The placement this call runs under.
 *
 * A chat send carries its resolved ref in the envelope. When the field did not
 * survive the hop but the call still names a session, recover that session's
 * own binding — the CLI rail already does exactly this
 * (`cli/src/plugin/plugin-tool-dispatch.ts`), and doing it here means the
 * renderer rail cannot drop a session's ceiling on the way to the tool.
 *
 * A session-bound call that finds NO placement is refused. These tools are only
 * surfaced to the model when the session has the sandbox enabled
 * (`build-options.ts` puts them in `opts.pluginTools` and disallows the
 * builtins), so reaching here without a binding means the placement was lost,
 * not declined — and answering that with an unpoliced host run is precisely the
 * silent fallback this plugin exists to prevent.
 *
 * Only a call that names no session at all — a workflow node, a plan step, an
 * External Bridge orchestration, a plugin-to-plugin call — takes the host
 * OS-tier placement, which is exactly where those ran before the runtime
 * reference existed.
 */
function requireRuntimeRef(sandbox: SandboxAPI, callCtx: PluginToolContext): string {
  if (callCtx.sandboxRuntimeRef) return callCtx.sandboxRuntimeRef
  const recovered = sandbox.activeRefForSession(callCtx.sessionId)
  if (recovered) return recovered
  if (callCtx.sessionId) {
    throw new SandboxRuntimeError(
      "placement-unavailable",
      "This session's sandbox placement is unavailable, so the command was not run. " +
        "Reopen the conversation or re-send to re-establish it."
    )
  }
  return sandbox.hostFallbackRuntimeRef
}

function parentDir(p: string): string {
  const sep = p.includes("\\") ? "\\" : "/"
  const idx = p.lastIndexOf(sep)
  return idx > 0 ? p.slice(0, idx) : "/"
}

/**
 * Read a file's content from INSIDE the sandbox. The file-tool policy
 * (`edit` / `write` / `text_editor`) grants read+write to exactly `path`,
 * so a read can never escape to an undeclared file. Throws when the
 * sandbox `cat` exits non-zero (missing file, permission denied, etc.).
 */
async function sandboxReadFile(
  sandbox: SandboxAPI,
  tool: FileToolName,
  args: FileCallBase,
  callCtx: PluginToolContext
): Promise<string> {
  const { path } = args
  // Clamp with an EMPTY `targetFiles` so the writable-root ceiling does not
  // gate a read (`narrowRequiredWriteScope` throws for a path outside the
  // roots), then restore the single target: the Rust `policy_for` rejects an
  // `edit` / `write` / `text_editor` request whose `target_files` is empty.
  const clamped = sandbox.clampRequest(requireRuntimeRef(sandbox, callCtx), {
    writable: [],
    readable: Array.from(new Set([...args.readable, path])),
    targetFiles: [],
    maxCpuSeconds: 0,
    maxMemoryMb: 0,
    network: "off" as const,
    networkHosts: [],
  })
  const request = { ...clamped, targetFiles: [path] }
  const res = await dispatchSandbox(
    sandbox,
    {
      tool,
      command: {
        argv: ["cat", "--", path],
        cwd: parentDir(path),
        env: {},
        stdin: null,
        timeout: args.timeoutSeconds,
      },
      request,
    },
    callCtx
  )
  if (res.exit_code !== 0) {
    throw new Error(res.stderr.trim() || `failed to read ${path} (exit ${res.exit_code})`)
  }
  return res.stdout
}

/**
 * Write `content` to `path` from INSIDE the sandbox. `cat > "$1"` pipes the
 * stdin payload to the single target file; the file-tool policy makes only
 * `path` writable, so the write is OS-confined and recorded in the sandbox
 * audit ring. Returns the raw result so callers can surface duration / etc.
 */
async function sandboxWriteFile(
  sandbox: SandboxAPI,
  tool: FileToolName,
  args: FileCallBase,
  content: string,
  callCtx: PluginToolContext
): Promise<SandboxResultShape> {
  const { path } = args
  const request = sandbox.clampRequest(requireRuntimeRef(sandbox, callCtx), {
    writable: [],
    readable: args.readable,
    targetFiles: [path],
    maxCpuSeconds: 0,
    maxMemoryMb: 0,
    network: "off" as const,
    networkHosts: [],
  })
  const res = await dispatchSandbox(
    sandbox,
    {
      tool,
      command: {
        // `$1` is the target path; `cat > "$1"` writes stdin verbatim. The
        // path is a separate argv element so it is never shell-interpreted.
        argv: ["bash", "-c", 'cat > "$1"', "sandbox_write", path],
        cwd: parentDir(path),
        env: {},
        stdin: content,
        timeout: args.timeoutSeconds,
      },
      request,
    },
    callCtx
  )
  if (res.exit_code !== 0) {
    throw new Error(res.stderr.trim() || `failed to write ${path} (exit ${res.exit_code})`)
  }
  return res
}

async function execWrite(
  sandbox: SandboxAPI,
  args: WriteCallInputs,
  callCtx: PluginToolContext
): Promise<SandboxResultShape> {
  assertPathUnderCeiling(sandbox, args.path, callCtx)
  return sandboxWriteFile(sandbox, TOOL_SANDBOX_WRITE, args, args.content, callCtx)
}

async function execEdit(
  sandbox: SandboxAPI,
  args: EditCallInputs,
  callCtx: PluginToolContext
): Promise<SandboxResultShape> {
  assertPathUnderCeiling(sandbox, args.path, callCtx)
  const current = await sandboxReadFile(sandbox, TOOL_SANDBOX_EDIT, args, callCtx)
  const next = applyStrReplace(current, args.oldString, args.newString, args.replaceAll)
  return sandboxWriteFile(sandbox, TOOL_SANDBOX_EDIT, args, next, callCtx)
}

async function execTextEditor(
  sandbox: SandboxAPI,
  args: TextEditorCallInputs,
  callCtx: PluginToolContext
): Promise<SandboxResultShape> {
  // Every sub-command except read-only `view` writes the target file.
  if (args.command !== "view") assertPathUnderCeiling(sandbox, args.path, callCtx)
  const tool = TOOL_SANDBOX_TEXT_EDITOR
  switch (args.command) {
    case "view": {
      const content = await sandboxReadFile(sandbox, tool, args, callCtx)
      const text = args.viewRange
        ? sliceViewRange(content, args.viewRange[0], args.viewRange[1])
        : content
      return { exit_code: 0, stdout: text, stderr: "", duration: 0, timed_out: false }
    }
    case "create":
      return sandboxWriteFile(sandbox, tool, args, args.fileText, callCtx)
    case "str_replace": {
      const current = await sandboxReadFile(sandbox, tool, args, callCtx)
      const next = applyStrReplace(current, args.oldStr, args.newStr)
      return sandboxWriteFile(sandbox, tool, args, next, callCtx)
    }
    case "insert": {
      const current = await sandboxReadFile(sandbox, tool, args, callCtx)
      const next = applyInsert(current, args.insertLine, args.insertText)
      return sandboxWriteFile(sandbox, tool, args, next, callCtx)
    }
  }
}

/**
 * The four tool registrations, bound to one plugin's `ctx.sandbox`.
 *
 * No `access` / `pathParams`: the sidecar confinement gate classifies these
 * four names itself (`RESERVED_PLUGIN_TOOL_NAMES` in
 * `sidecar/builtin-tools/confinement.mjs`) and refuses a manifest-declared
 * re-classification of them.
 */
export function buildSandboxedTools(sandbox: SandboxAPI): PluginToolRegistration[] {
  return [
    definePluginTool({
      name: TOOL_SANDBOX_BASH,
      definition: {
        name: TOOL_SANDBOX_BASH,
        description: SANDBOX_BASH_DESCRIPTION,
        category: "automation",
        requiresApproval: true,
        timeoutMs: SANDBOX_BASH_TIMEOUT_MS,
        parametersSchema: SANDBOX_BASH_SCHEMA,
      },
      execute: async (args, callCtx) => execBash(sandbox, readBashInputs(args), callCtx),
    }),
    definePluginTool({
      name: TOOL_SANDBOX_EDIT,
      definition: {
        name: TOOL_SANDBOX_EDIT,
        description: SANDBOX_EDIT_DESCRIPTION,
        category: "automation",
        requiresApproval: true,
        timeoutMs: SANDBOX_FILE_TOOL_TIMEOUT_MS,
        parametersSchema: SANDBOX_EDIT_SCHEMA,
      },
      execute: async (args, callCtx) => execEdit(sandbox, readEditInputs(args), callCtx),
    }),
    definePluginTool({
      name: TOOL_SANDBOX_WRITE,
      definition: {
        name: TOOL_SANDBOX_WRITE,
        description: SANDBOX_WRITE_DESCRIPTION,
        category: "automation",
        requiresApproval: true,
        timeoutMs: SANDBOX_FILE_TOOL_TIMEOUT_MS,
        parametersSchema: SANDBOX_WRITE_SCHEMA,
      },
      execute: async (args, callCtx) => execWrite(sandbox, readWriteInputs(args), callCtx),
    }),
    definePluginTool({
      name: TOOL_SANDBOX_TEXT_EDITOR,
      definition: {
        name: TOOL_SANDBOX_TEXT_EDITOR,
        description: SANDBOX_TEXT_EDITOR_DESCRIPTION,
        category: "automation",
        requiresApproval: true,
        timeoutMs: SANDBOX_FILE_TOOL_TIMEOUT_MS,
        parametersSchema: SANDBOX_TEXT_EDITOR_SCHEMA,
      },
      execute: async (args, callCtx) =>
        execTextEditor(sandbox, readTextEditorInputs(args), callCtx),
    }),
  ]
}

export const SANDBOXED_TOOL_NAMES = [
  TOOL_SANDBOX_BASH,
  TOOL_SANDBOX_EDIT,
  TOOL_SANDBOX_WRITE,
  TOOL_SANDBOX_TEXT_EDITOR,
] as const

/** SDK builtin tool names that are replaced when the sandbox is enabled. */
export const SDK_TOOLS_REPLACED_BY_SANDBOX = ["Bash", "Edit", "Write"] as const

// plugin.json is the manifest source of truth; this plugin adds no
// TypeScript-only contributions (its tools register imperatively below).
export const manifest = definePluginManifest(manifestJson)

// No `deactivate`: the host unregisters a plugin's tools on every teardown
// path (disable, suspend, unload — `unregisterPluginContributions`), and the
// tools hold no other resource.
export default definePlugin({
  manifest,
  activate: (ctx) => {
    for (const tool of buildSandboxedTools(ctx.sandbox)) ctx.agent.registerTool(tool)
    ctx.logger.info("cognia-sandboxed-tools plugin activated")
  },
})
