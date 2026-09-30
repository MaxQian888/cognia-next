/**
 * MCP registrations for the workspace / git / shell tool family (roadmap
 * 2026-09-29, Phase 2; ADR-0203).
 *
 * Kept out of `server.ts` so the family's schemas, descriptions and audit
 * projections read as one unit; the server passes in its own gate so every
 * call still runs `runWithGate` (scope check → audit → envelope). Execution is
 * `../handlers/workspace`, which the MCP sidecar bundle swaps for the
 * orchestration-proxy forwarder.
 *
 * Envelope split, same as the browser tools: `structuredContent` is read by
 * clients as trusted JSON outside any fence, so it carries ONLY control fields
 * (outcome, continuation, follow-up, clamps, attention). Everything that came
 * out of the workspace — file text, paths, diffs, command output — travels in
 * the `<untrusted_content>`-fenced text block.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"

import type { ExternalBridgeSettings } from "@/types/wiki"
import { checkToolCall } from "../permission-gate"
import { wrapUntrusted } from "../untrusted"
import { workspaceTool, type WorkspaceToolOutput } from "../handlers/workspace"
import { WORKSPACE_TOOL_SCOPES, type WorkspaceToolName } from "../workspace/tool-names"

type Extra = { _meta?: Record<string, unknown> }

type Envelope = {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>
  structuredContent?: Record<string, unknown>
  isError?: boolean
  [key: string]: unknown
}

/** The pieces of `server.ts` a registration needs. */
export interface WorkspaceToolRuntime {
  run(input: {
    tool: string
    scope: WorkspaceBridgeScopeLike
    check: { allowed: true } | { allowed: false; reason: string }
    body: () => Promise<WorkspaceToolOutput>
    present: (result: WorkspaceToolOutput) => Envelope
    audit: () => Record<string, unknown>
  }): Promise<Envelope>
  settingsFor(extra: Extra): Promise<ExternalBridgeSettings | undefined>
  caller(extra: Extra): string
}

type WorkspaceBridgeScopeLike = (typeof WORKSPACE_TOOL_SCOPES)[WorkspaceToolName]

/** Fields safe to hand a client as trusted JSON. Everything else is data. */
const CONTROL_FIELDS = [
  "ok",
  "code",
  "failureStage",
  "stateChanged",
  "outcomeUnknown",
  "followUp",
  "executionState",
  "continuation",
  "next",
  "adjusted",
  "redacted",
  "attention",
  "truncated",
  "truncatedAtBytes",
  "hidden",
  "lines",
  "jobId",
  "status",
  "exitCode",
  "created",
  "bytes",
  "replacements",
  "alreadyFinished",
  "files",
] as const

export function presentWorkspaceTool(output: WorkspaceToolOutput): Envelope {
  const record = output as Record<string, unknown>
  const structuredContent: Record<string, unknown> = {}
  for (const field of CONTROL_FIELDS) {
    const value = record[field]
    // `files` is a count on git_diff but a path list on git_show: only the
    // count is control data.
    if (field === "files" && typeof value !== "number") continue
    if (value !== undefined) structuredContent[field] = value
  }
  return {
    content: [{ type: "text", text: wrapUntrusted(JSON.stringify(output)) }],
    structuredContent,
    ...(output.ok ? {} : { isError: true }),
  }
}

// ---- schemas ----------------------------------------------------------------

const root = z.string().describe("Root id from workspace_roots")
const relPath = (what: string) =>
  z.string().optional().describe(`${what}, relative to the root (forward slashes, no '..')`)

interface ToolSpec {
  title: string
  description: string
  inputSchema: z.ZodRawShape
  readOnly: boolean
  destructive?: boolean
  idempotent?: boolean
  /** Audit projection: what this call touched, never raw arguments. */
  audit: (args: Record<string, unknown>) => Record<string, unknown>
}

const s = (value: unknown) => (typeof value === "string" ? value : undefined)

const rootAndPath = (args: Record<string, unknown>) => ({ root: s(args.root), path: s(args.path) })

const SPECS: Record<WorkspaceToolName, ToolSpec> = {
  workspace_roots: {
    title: "Workspace: roots",
    description:
      "List the workspace roots this client may use (id, label, workspace). Every other workspace, git and shell tool takes one of these ids as `root`; paths are always relative to it.",
    inputSchema: {},
    readOnly: true,
    idempotent: true,
    audit: () => ({}),
  },
  workspace_list: {
    title: "Workspace: list",
    description:
      "List files and directories under a path of a granted root, honouring .gitignore. Credential files and .git internals are never listed; dependency/build trees (node_modules, target, dist, …) are skipped unless includeBulk is set. `hidden` counts what was left out.",
    inputSchema: {
      root,
      path: relPath("Directory to list (default: the root)"),
      depth: z.number().int().optional().describe("Directory depth, 1–8 (default 2)"),
      maxEntries: z.number().int().optional().describe("Entry cap, 1–2000 (default 500)"),
      includeBulk: z.boolean().optional().describe("Also list dependency/build trees"),
    },
    readOnly: true,
    idempotent: true,
    audit: rootAndPath,
  },
  workspace_read: {
    title: "Workspace: read file",
    description:
      "Read a text file of a granted root, optionally a line window (offset is 1-based). Credential files are refused. Personal data is redacted (placeholders like <EMAIL_001>); never write a placeholder back.",
    inputSchema: {
      root,
      path: z.string().describe("File path relative to the root"),
      offset: z.number().int().optional().describe("First line to return, 1-based"),
      limit: z.number().int().optional().describe("Lines to return, 1–5000 (default 2000)"),
      maxBytes: z.number().int().optional().describe("Byte budget, 1 KiB–1 MiB (default 256 KiB)"),
    },
    readOnly: true,
    idempotent: true,
    audit: rootAndPath,
  },
  workspace_search: {
    title: "Workspace: search",
    description:
      "Search a granted root: mode `content` (default) greps file contents, mode `name` matches file names. Optional `path` narrows to a subdirectory. Credential files and .git are never searched; dependency/build trees only with includeBulk.",
    inputSchema: {
      root,
      query: z.string().describe("Text (or regex with regex: true) to find"),
      mode: z.enum(["content", "name"]).optional(),
      path: relPath("Subdirectory to search"),
      regex: z.boolean().optional(),
      caseSensitive: z.boolean().optional(),
      maxResults: z.number().int().optional().describe("1–200 (default 50)"),
      includeBulk: z.boolean().optional(),
    },
    readOnly: true,
    idempotent: true,
    audit: (args) => ({ root: s(args.root), path: s(args.path), mode: s(args.mode) ?? "content" }),
  },
  workspace_write: {
    title: "Workspace: write file",
    description:
      "Write a whole text file in a granted root, creating parent directories. mode `create` refuses to overwrite an existing file. Refused for credential paths and for content containing a redaction placeholder.",
    inputSchema: {
      root,
      path: z.string().describe("File path relative to the root"),
      content: z.string(),
      mode: z.enum(["overwrite", "create"]).optional().describe("Default overwrite"),
    },
    readOnly: false,
    destructive: true,
    audit: rootAndPath,
  },
  workspace_edit: {
    title: "Workspace: edit file",
    description:
      "Replace exact text in a file of a granted root. oldString must occur exactly once unless replaceAll is set. Refused when either string contains a redaction placeholder.",
    inputSchema: {
      root,
      path: z.string().describe("File path relative to the root"),
      oldString: z.string(),
      newString: z.string(),
      replaceAll: z.boolean().optional(),
    },
    readOnly: false,
    destructive: true,
    audit: rootAndPath,
  },
  workspace_move: {
    title: "Workspace: move",
    description:
      "Move or rename a file or directory within a granted root. Never overwrites an existing destination.",
    inputSchema: {
      root,
      from: z.string().describe("Source path relative to the root"),
      to: z.string().describe("Destination path relative to the root"),
    },
    readOnly: false,
    destructive: true,
    audit: (args) => ({ root: s(args.root), from: s(args.from), to: s(args.to) }),
  },
  workspace_delete: {
    title: "Workspace: delete",
    description:
      "Delete a file or directory (recursive: true for a non-empty directory) in a granted root. The user approves every delete in Cognia.",
    inputSchema: {
      root,
      path: z.string().describe("Path relative to the root"),
      recursive: z.boolean().optional(),
    },
    readOnly: false,
    destructive: true,
    audit: rootAndPath,
  },
  git_status: {
    title: "Git: status",
    description:
      "Branch, upstream and changed files (staged, unstaged, conflicts) of a granted root's repository. Credential paths are left out and counted in `hidden`.",
    inputSchema: { root },
    readOnly: true,
    idempotent: true,
    audit: (args) => ({ root: s(args.root) }),
  },
  git_diff: {
    title: "Git: diff",
    description:
      "Unified diff of the working tree. With `path`, one file (staged: true for the index side). Without, every changed file; staged: true = index only, false = unstaged only, omitted = both.",
    inputSchema: {
      root,
      path: relPath("One file to diff"),
      staged: z.boolean().optional(),
      maxChars: z.number().int().optional().describe("1000–200000 (default 40000)"),
    },
    readOnly: true,
    idempotent: true,
    audit: (args) => ({ root: s(args.root), path: s(args.path) }),
  },
  git_log: {
    title: "Git: log",
    description:
      "Recent commits (hash, summary, author, date), or one file's history with `path`. Page with skip; `next` carries the following page's call.",
    inputSchema: {
      root,
      path: relPath("File whose history to list"),
      limit: z.number().int().optional().describe("1–100 (default 20)"),
      skip: z.number().int().optional(),
    },
    readOnly: true,
    idempotent: true,
    audit: (args) => ({ root: s(args.root), path: s(args.path) }),
  },
  git_show: {
    title: "Git: show commit",
    description: "Files changed by a commit, or with `path` that file's diff in the commit.",
    inputSchema: {
      root,
      rev: z.string().describe("Commit hash or ref"),
      path: relPath("File whose diff to show"),
      maxChars: z.number().int().optional(),
    },
    readOnly: true,
    idempotent: true,
    audit: (args) => ({ root: s(args.root), rev: s(args.rev), path: s(args.path) }),
  },
  shell_run: {
    title: "Shell: run command",
    description:
      "Run a shell command in a granted root (optional cwd below it) as a supervised background job. Returns its output when it finishes within waitMs; otherwise executionState `pending` with a `continuation` — call it to keep reading. Dangerous commands are refused; risky ones, and ones naming a credential path, ask the user in Cognia first. Job exits reported later arrive in `attention` on any tool result.",
    inputSchema: {
      root,
      command: z.string().describe("Shell command line"),
      cwd: relPath("Working directory"),
      waitMs: z
        .number()
        .int()
        .optional()
        .describe("How long to wait for completion, 0–30000 (default 10000)"),
      maxBytes: z.number().int().optional().describe("Output budget, 1–64 KiB (default 16 KiB)"),
    },
    readOnly: false,
    destructive: true,
    // Only the command head: the rest of the line can carry secrets.
    audit: (args) => ({
      root: s(args.root),
      cwd: s(args.cwd),
      command: s(args.command)?.trim().split(/\s+/)[0],
    }),
  },
  job_output: {
    title: "Shell: job output",
    description:
      "Read a job's output from a byte offset, waiting up to waitMs for more. Returns `pending` with the next continuation while the job runs, or its exit status once it has finished.",
    inputSchema: {
      jobId: z.string(),
      fromOffset: z.number().int().optional(),
      waitMs: z.number().int().optional(),
      maxBytes: z.number().int().optional(),
    },
    readOnly: true,
    audit: (args) => ({ jobId: s(args.jobId) }),
  },
  job_list: {
    title: "Shell: list jobs",
    description: "Jobs this client started, with their status and exit codes.",
    inputSchema: {},
    readOnly: true,
    idempotent: true,
    audit: () => ({}),
  },
  job_kill: {
    title: "Shell: stop job",
    description: "Stop a running job this client started (its whole process group).",
    inputSchema: { jobId: z.string() },
    readOnly: false,
    destructive: true,
    idempotent: true,
    audit: (args) => ({ jobId: s(args.jobId) }),
  },
}

export const __WORKSPACE_TOOL_SPECS_FOR_TESTS = SPECS

export function registerWorkspaceTools(server: McpServer, runtime: WorkspaceToolRuntime): void {
  for (const [name, spec] of Object.entries(SPECS) as Array<[WorkspaceToolName, ToolSpec]>) {
    const scope = WORKSPACE_TOOL_SCOPES[name]
    server.registerTool(
      name,
      {
        title: spec.title,
        description: `${spec.description} Denied until the \`${scope}\` scope is enabled and a root is granted in Settings → External Bridge.`,
        annotations: {
          readOnlyHint: spec.readOnly,
          destructiveHint: spec.destructive === true,
          idempotentHint: spec.idempotent === true,
          openWorldHint: false,
        },
        inputSchema: spec.inputSchema,
      },
      async (args: Record<string, unknown>, extra: Extra) => {
        const input = args ?? {}
        return runtime.run({
          tool: name,
          scope,
          check: checkToolCall(await runtime.settingsFor(extra), name),
          body: () => workspaceTool({ tool: name, args: input, clientId: runtime.caller(extra) }),
          present: presentWorkspaceTool,
          audit: () => spec.audit(input),
        })
      }
    )
  }
}
