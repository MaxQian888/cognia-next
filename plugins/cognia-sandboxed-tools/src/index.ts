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

import type {
  PluginContext,
  PluginDefinition,
  PluginTool,
  PluginToolContext,
} from "@cognia/plugin-sdk"
import type { MicrovmExecPayload } from "@cognia/plugin-sdk/api/sandbox"
import { SandboxRuntimeError } from "@cognia/plugin-sdk/api/sandbox"
import { applyInsert, applyStrReplace, sliceViewRange } from "./edit-ops"

const PLUGIN_ID = "cognia-sandboxed-tools"
let sandbox: PluginContext["sandbox"] | undefined

function requireSandbox(): PluginContext["sandbox"] {
  if (!sandbox) throw new Error("Sandboxed Tools context is unavailable")
  return sandbox
}

const TOOL_SANDBOX_BASH = "sandbox_bash"
const TOOL_SANDBOX_EDIT = "sandbox_edit"
const TOOL_SANDBOX_WRITE = "sandbox_write"
const TOOL_SANDBOX_TEXT_EDITOR = "sandbox_text_editor"

const SANDBOX_BASH_DESCRIPTION =
  "Execute a shell command inside an OS-level sandbox (sandbox-exec on macOS, bwrap on " +
  "Linux). Reads / writes are confined to the writable / readable paths the caller " +
  "supplies; network is denied unless explicitly opted in. Returns stdout, stderr, " +
  "exit code, and a `timed_out` flag. Use this instead of the unsandboxed Bash tool."

const SANDBOX_EDIT_DESCRIPTION =
  "Edit an existing file inside the sandbox. Writes are scoped to the exact file paths " +
  "in target_files; nothing else on the filesystem is writable. Network always denied. " +
  "Use this instead of the unsandboxed Edit tool."

const SANDBOX_WRITE_DESCRIPTION =
  "Create or overwrite a file inside the sandbox. Same shape as sandbox_edit; writes " +
  "are scoped to target_files only. Use this instead of the unsandboxed Write tool."

const SANDBOX_TEXT_EDITOR_DESCRIPTION =
  "Anthropic-style text editor (view / create / str_replace / insert) executed inside " +
  "the sandbox. The read and write both run under the OS sandbox, confined to the " +
  "target path. Replaces the native text_editor tool when sandbox mode is enabled."

const SANDBOX_BASH_SCHEMA = {
  type: "object",
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
    timeoutSeconds: { type: "integer", minimum: 0 },
    maxCpuSeconds: { type: "integer", minimum: 0 },
    maxMemoryMb: { type: "integer", minimum: 0 },
  },
} as const

const SANDBOX_EDIT_SCHEMA = {
  type: "object",
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
    readable: { type: "array", items: { type: "string" }, description: "Extra read-only paths." },
    timeoutSeconds: { type: "integer", minimum: 0 },
  },
} as const

const SANDBOX_WRITE_SCHEMA = {
  type: "object",
  required: ["path", "content"],
  properties: {
    path: { type: "string", description: "Absolute path of the file to create or overwrite." },
    content: { type: "string", description: "Full file content to write." },
    readable: { type: "array", items: { type: "string" }, description: "Extra read-only paths." },
    timeoutSeconds: { type: "integer", minimum: 0 },
  },
} as const

const SANDBOX_TEXT_EDITOR_SCHEMA = {
  type: "object",
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
    readable: { type: "array", items: { type: "string" }, description: "Extra read-only paths." },
    timeoutSeconds: { type: "integer", minimum: 0 },
  },
} as const

interface BashCallInputs {
  command: string
  cwd: string
  writable?: string[]
  readable?: string[]
  network?: "off" | "on" | "allowlist"
  networkHosts?: string[]
  timeoutSeconds?: number
  maxCpuSeconds?: number
  maxMemoryMb?: number
  env?: Record<string, string>
}

/** Tool names whose `policy_for` maps to a single-file write scope. */
type FileToolName =
  typeof TOOL_SANDBOX_EDIT | typeof TOOL_SANDBOX_WRITE | typeof TOOL_SANDBOX_TEXT_EDITOR

interface WriteCallInputs {
  path: string
  content: string
  readable?: string[]
  timeoutSeconds?: number
  env?: Record<string, string>
}

interface EditCallInputs {
  path: string
  oldString: string
  newString: string
  replaceAll?: boolean
  readable?: string[]
  timeoutSeconds?: number
  env?: Record<string, string>
}

interface TextEditorCallInputs {
  command: "view" | "create" | "str_replace" | "insert"
  path: string
  fileText?: string
  oldStr?: string
  newStr?: string
  insertLine?: number
  insertText?: string
  viewRange?: [number, number]
  readable?: string[]
  timeoutSeconds?: number
  env?: Record<string, string>
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

/**
 * Dispatch a `sandbox_exec` payload either through the OS sandbox
 * (`sandbox_exec` Tauri command) or through the e2b microVM bridge,
 * based on the active tier for this session.
 *
 * Strict mode: when the active tier is `"microvm"` but no microvm
 * exec is registered (the e2b plugin is disabled or
 * `@e2b/sdk` isn't installed), throw — no silent fallback to the OS
 * tier, in line with ADR-0028 §Strict mode.
 */
async function dispatchSandbox(
  payload: MicrovmExecPayload,
  ctx: PluginToolContext
): Promise<SandboxResultShape> {
  return requireSandbox().execute(requireRuntimeRef(ctx), payload)
}

async function execBash(args: BashCallInputs, ctx: PluginToolContext): Promise<SandboxResultShape> {
  const cwd = args.cwd
  assertPathUnderCeiling(cwd, ctx, "working directory")
  const runtimeRef = requireRuntimeRef(ctx)
  const explicitWritable = args.writable && args.writable.length > 0 ? args.writable : null
  const narrowedExplicitWritable = explicitWritable
    ? requireSandbox().clampRequest(runtimeRef, {
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
  const request = requireSandbox().clampRequest(runtimeRef, {
    writable,
    readable: args.readable ?? [],
    targetFiles: [],
    maxCpuSeconds: args.maxCpuSeconds ?? 0,
    maxMemoryMb: args.maxMemoryMb ?? 0,
    network: args.network ?? "off",
    networkHosts: args.networkHosts ?? [],
  })
  return dispatchSandbox(
    {
      tool: TOOL_SANDBOX_BASH,
      command: {
        argv: ["bash", "-c", args.command],
        cwd,
        env: args.env ?? {},
        stdin: null,
        timeout: args.timeoutSeconds ?? 300,
      },
      request,
    },
    ctx
  )
}

/**
 * Enforce the per-session writable-root ceiling on a single-file write target.
 * Bash narrows its writable set via `clampPolicyRequest`; the file tools take a
 * single `path` directly, so they guard here. No ceiling configured → no-op
 * (the always-on Rust floor still rejects system / app-data targets).
 */
function assertPathUnderCeiling(path: string, ctx: PluginToolContext, label = "path"): void {
  requireSandbox().assertWritablePath(requireRuntimeRef(ctx), path, label)
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
function requireRuntimeRef(ctx: PluginToolContext): string {
  if (ctx.sandboxRuntimeRef) return ctx.sandboxRuntimeRef
  const recovered = requireSandbox().activeRefForSession(ctx.sessionId)
  if (recovered) return recovered
  if (ctx.sessionId) {
    throw new SandboxRuntimeError(
      "placement-unavailable",
      "This session's sandbox placement is unavailable, so the command was not run. " +
        "Reopen the conversation or re-send to re-establish it."
    )
  }
  return requireSandbox().hostFallbackRuntimeRef
}

function parentDir(p: string): string {
  const sep = p.includes("\\") ? "\\" : "/"
  const idx = p.lastIndexOf(sep)
  return idx > 0 ? p.slice(0, idx) : "/"
}

const DEFAULT_FILE_TOOL_TIMEOUT_SECONDS = 60

/**
 * Read a file's content from INSIDE the sandbox. The file-tool policy
 * (`edit` / `write` / `text_editor`) grants read+write to exactly `path`,
 * so a read can never escape to an undeclared file. Throws when the
 * sandbox `cat` exits non-zero (missing file, permission denied, etc.).
 */
async function sandboxReadFile(
  tool: FileToolName,
  path: string,
  readable: string[],
  timeoutSeconds: number,
  ctx: PluginToolContext,
  env?: Record<string, string>
): Promise<string> {
  // Clamp with an EMPTY `targetFiles` so the writable-root ceiling does not
  // gate a read (`narrowRequiredWriteScope` throws for a path outside the
  // roots), then restore the single target: the Rust `policy_for` rejects an
  // `edit` / `write` / `text_editor` request whose `target_files` is empty.
  const clamped = requireSandbox().clampRequest(requireRuntimeRef(ctx), {
    writable: [],
    readable: Array.from(new Set([...readable, path])),
    targetFiles: [],
    maxCpuSeconds: 0,
    maxMemoryMb: 0,
    network: "off" as const,
    networkHosts: [],
  })
  const request = { ...clamped, targetFiles: [path] }
  const res = await dispatchSandbox(
    {
      tool,
      command: {
        argv: ["cat", "--", path],
        cwd: parentDir(path),
        env: env ?? {},
        stdin: null,
        timeout: timeoutSeconds,
      },
      request,
    },
    ctx
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
  tool: FileToolName,
  path: string,
  content: string,
  readable: string[],
  timeoutSeconds: number,
  ctx: PluginToolContext,
  env?: Record<string, string>
): Promise<SandboxResultShape> {
  const request = requireSandbox().clampRequest(requireRuntimeRef(ctx), {
    writable: [],
    readable,
    targetFiles: [path],
    maxCpuSeconds: 0,
    maxMemoryMb: 0,
    network: "off" as const,
    networkHosts: [],
  })
  const res = await dispatchSandbox(
    {
      tool,
      command: {
        // `$1` is the target path; `cat > "$1"` writes stdin verbatim. The
        // path is a separate argv element so it is never shell-interpreted.
        argv: ["bash", "-c", 'cat > "$1"', "sandbox_write", path],
        cwd: parentDir(path),
        env: env ?? {},
        stdin: content,
        timeout: timeoutSeconds,
      },
      request,
    },
    ctx
  )
  if (res.exit_code !== 0) {
    throw new Error(res.stderr.trim() || `failed to write ${path} (exit ${res.exit_code})`)
  }
  return res
}

async function execWrite(
  args: WriteCallInputs,
  ctx: PluginToolContext
): Promise<SandboxResultShape> {
  assertPathUnderCeiling(args.path, ctx)
  const timeout = args.timeoutSeconds ?? DEFAULT_FILE_TOOL_TIMEOUT_SECONDS
  return sandboxWriteFile(
    TOOL_SANDBOX_WRITE,
    args.path,
    args.content,
    args.readable ?? [],
    timeout,
    ctx,
    args.env
  )
}

async function execEdit(args: EditCallInputs, ctx: PluginToolContext): Promise<SandboxResultShape> {
  assertPathUnderCeiling(args.path, ctx)
  const timeout = args.timeoutSeconds ?? DEFAULT_FILE_TOOL_TIMEOUT_SECONDS
  const readable = args.readable ?? []
  const current = await sandboxReadFile(
    TOOL_SANDBOX_EDIT,
    args.path,
    readable,
    timeout,
    ctx,
    args.env
  )
  const next = applyStrReplace(current, args.oldString, args.newString, args.replaceAll ?? false)
  return sandboxWriteFile(TOOL_SANDBOX_EDIT, args.path, next, readable, timeout, ctx, args.env)
}

async function execTextEditor(
  args: TextEditorCallInputs,
  ctx: PluginToolContext
): Promise<SandboxResultShape> {
  // Every sub-command except read-only `view` writes the target file.
  if (args.command !== "view") assertPathUnderCeiling(args.path, ctx)
  const timeout = args.timeoutSeconds ?? DEFAULT_FILE_TOOL_TIMEOUT_SECONDS
  const readable = args.readable ?? []
  const tool = TOOL_SANDBOX_TEXT_EDITOR
  switch (args.command) {
    case "view": {
      const content = await sandboxReadFile(tool, args.path, readable, timeout, ctx, args.env)
      const text = args.viewRange
        ? sliceViewRange(content, args.viewRange[0], args.viewRange[1])
        : content
      return { exit_code: 0, stdout: text, stderr: "", duration: 0, timed_out: false }
    }
    case "create": {
      return sandboxWriteFile(
        tool,
        args.path,
        args.fileText ?? "",
        readable,
        timeout,
        ctx,
        args.env
      )
    }
    case "str_replace": {
      const current = await sandboxReadFile(tool, args.path, readable, timeout, ctx, args.env)
      const next = applyStrReplace(current, args.oldStr ?? "", args.newStr ?? "")
      return sandboxWriteFile(tool, args.path, next, readable, timeout, ctx, args.env)
    }
    case "insert": {
      const current = await sandboxReadFile(tool, args.path, readable, timeout, ctx, args.env)
      const next = applyInsert(current, args.insertLine ?? 0, args.insertText ?? "")
      return sandboxWriteFile(tool, args.path, next, readable, timeout, ctx, args.env)
    }
    default: {
      throw new Error(`unknown text_editor command: ${String(args.command)}`)
    }
  }
}

function buildPluginTools(): PluginTool[] {
  return [
    {
      name: TOOL_SANDBOX_BASH,
      pluginId: PLUGIN_ID,
      definition: {
        name: TOOL_SANDBOX_BASH,
        description: SANDBOX_BASH_DESCRIPTION,
        category: "automation",
        requiresApproval: true,
        parametersSchema: SANDBOX_BASH_SCHEMA as unknown as Record<string, unknown>,
      },
      execute: async (args, ctx) => execBash(args as unknown as BashCallInputs, ctx),
    },
    {
      name: TOOL_SANDBOX_EDIT,
      pluginId: PLUGIN_ID,
      definition: {
        name: TOOL_SANDBOX_EDIT,
        description: SANDBOX_EDIT_DESCRIPTION,
        category: "automation",
        requiresApproval: true,
        parametersSchema: SANDBOX_EDIT_SCHEMA as unknown as Record<string, unknown>,
      },
      execute: async (args, ctx) => execEdit(args as unknown as EditCallInputs, ctx),
    },
    {
      name: TOOL_SANDBOX_WRITE,
      pluginId: PLUGIN_ID,
      definition: {
        name: TOOL_SANDBOX_WRITE,
        description: SANDBOX_WRITE_DESCRIPTION,
        category: "automation",
        requiresApproval: true,
        parametersSchema: SANDBOX_WRITE_SCHEMA as unknown as Record<string, unknown>,
      },
      execute: async (args, ctx) => execWrite(args as unknown as WriteCallInputs, ctx),
    },
    {
      name: TOOL_SANDBOX_TEXT_EDITOR,
      pluginId: PLUGIN_ID,
      definition: {
        name: TOOL_SANDBOX_TEXT_EDITOR,
        description: SANDBOX_TEXT_EDITOR_DESCRIPTION,
        category: "automation",
        requiresApproval: true,
        parametersSchema: SANDBOX_TEXT_EDITOR_SCHEMA as unknown as Record<string, unknown>,
      },
      execute: async (args, ctx) => execTextEditor(args as unknown as TextEditorCallInputs, ctx),
    },
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

const definition: PluginDefinition = {
  manifest: {
    id: PLUGIN_ID,
    name: "Sandboxed Tools",
    version: "0.1.0",
    type: "frontend",
    capabilities: ["tools"],
    main: "src/index.ts",
    permissions: ["native:filesystem", "native:process", "session:read"],
    i18n: {
      locales: {
        en: {
          "slash.sandbox.description": "Show sandboxed-tools plugin status.",
          "slash.sandbox.body":
            "Sandboxed Tools plugin is active. When the active session enables sandbox " +
            "mode, SDK builtin Bash / Edit / Write are disabled and the model uses the " +
            "sandbox_* equivalents instead. Backend is platform-specific — see Settings " +
            "→ Sandbox for health status.",
        },
        "zh-CN": {
          "slash.sandbox.description": "显示沙盒工具插件状态。",
          "slash.sandbox.body":
            "沙盒工具插件已激活。当会话启用沙盒模式时,SDK 内建的 Bash / Edit / Write 被禁用,模型改用 sandbox_* 对应工具。" +
            "后端按平台不同 —— 健康状态见 设置 → 沙盒。",
        },
      },
    },
  } as never,
  activate: async (ctx: PluginContext) => {
    ctx.logger?.info("cognia-sandboxed-tools plugin activated")
    sandbox = ctx.sandbox
    if (ctx.agent?.registerTool) {
      for (const tool of buildPluginTools()) {
        ctx.agent.registerTool(tool)
      }
    } else {
      ctx.logger?.warn(
        "ctx.agent.registerTool unavailable — sandboxed-tools chat path will not surface tools"
      )
    }
  },
  deactivate: async (ctx?: PluginContext) => {
    if (ctx?.agent?.unregisterTool) {
      for (const name of SANDBOXED_TOOL_NAMES) {
        ctx.agent.unregisterTool(name)
      }
    }
    sandbox = undefined
  },
}

export default definition
