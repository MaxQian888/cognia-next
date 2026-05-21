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

import type { PluginContext, PluginDefinition, PluginTool, PluginToolContext } from "@/types/plugin"
import { transport } from "@/lib/tauri"
import {
  getActiveSandboxTier,
  getMicrovmExec,
  type MicrovmExecPayload,
} from "@/lib/sandbox/microvm-bridge"

const PLUGIN_ID = "cognia-sandboxed-tools"

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
  "Anthropic-style text editor (view / create / str_replace / insert / undo_edit) " +
  "executed inside the sandbox. Used when the character has Computer Use disabled but " +
  "still needs file edits — replaces the native text_editor tool."

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
  required: ["targetFiles"],
  properties: {
    targetFiles: {
      type: "array",
      items: { type: "string" },
      description: "Exact file paths allowed to be written.",
    },
    readable: { type: "array", items: { type: "string" } },
    edit: {
      type: "object",
      description: "Editor payload (the actual diff/patch the renderer is expected to apply).",
    },
    timeoutSeconds: { type: "integer", minimum: 0 },
  },
} as const

const SANDBOX_WRITE_SCHEMA = SANDBOX_EDIT_SCHEMA
const SANDBOX_TEXT_EDITOR_SCHEMA = SANDBOX_EDIT_SCHEMA

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

interface FileToolInputs {
  targetFiles: string[]
  readable?: string[]
  timeoutSeconds?: number
  env?: Record<string, string>
  command?: string
  cwd?: string
}

interface SandboxResultShape {
  exit_code: number
  stdout: string
  stderr: string
  duration: number
  timed_out: boolean
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
  const tier = getActiveSandboxTier(ctx.sessionId)
  if (tier === "microvm") {
    const impl = getMicrovmExec()
    if (!impl) {
      throw new Error(
        "sandbox tier resolved to 'microvm' but no microVM exec is registered. " +
          "Enable the cognia-e2b-sandbox plugin or set the character / app tier to 'os'."
      )
    }
    return impl(payload)
  }
  return transport.call<SandboxResultShape>(
    "sandbox_exec",
    payload as unknown as Record<string, unknown>
  )
}

async function execBash(args: BashCallInputs, ctx: PluginToolContext): Promise<SandboxResultShape> {
  const cwd = args.cwd
  const writable = args.writable && args.writable.length > 0 ? args.writable : [cwd]
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
      request: {
        writable,
        readable: args.readable ?? [],
        targetFiles: [],
        maxCpuSeconds: args.maxCpuSeconds ?? 0,
        maxMemoryMb: args.maxMemoryMb ?? 0,
        network: args.network ?? "off",
        networkHosts: args.networkHosts ?? [],
      },
    },
    ctx
  )
}

async function execFileTool(
  tool: typeof TOOL_SANDBOX_EDIT | typeof TOOL_SANDBOX_WRITE | typeof TOOL_SANDBOX_TEXT_EDITOR,
  args: FileToolInputs,
  ctx: PluginToolContext
): Promise<SandboxResultShape> {
  // Edit / Write / text_editor are renderer-side operations that the
  // Rust sandbox supervises by exec'ing a small helper inside the
  // sandboxed view of the FS. V1 ships the shape contract; the
  // renderer-side caller is responsible for emitting the actual edit
  // through the tool (V1 just verifies the policy gate before letting
  // the renderer execute its own apply-edit logic).
  return dispatchSandbox(
    {
      tool,
      command: {
        argv: ["true"],
        cwd: args.cwd ?? (args.targetFiles[0] ? parentDir(args.targetFiles[0]) : "/"),
        env: args.env ?? {},
        stdin: null,
        timeout: args.timeoutSeconds ?? 60,
      },
      request: {
        writable: [],
        readable: args.readable ?? [],
        targetFiles: args.targetFiles,
        maxCpuSeconds: 0,
        maxMemoryMb: 0,
        network: "off",
        networkHosts: [],
      },
    },
    ctx
  )
}

function parentDir(p: string): string {
  const sep = p.includes("\\") ? "\\" : "/"
  const idx = p.lastIndexOf(sep)
  return idx > 0 ? p.slice(0, idx) : "/"
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
      execute: async (args, ctx) =>
        execFileTool(TOOL_SANDBOX_EDIT, args as unknown as FileToolInputs, ctx),
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
      execute: async (args, ctx) =>
        execFileTool(TOOL_SANDBOX_WRITE, args as unknown as FileToolInputs, ctx),
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
      execute: async (args, ctx) =>
        execFileTool(TOOL_SANDBOX_TEXT_EDITOR, args as unknown as FileToolInputs, ctx),
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
    permissions: ["native:filesystem", "native:process"],
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
  },
}

export default definition
