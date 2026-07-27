import { hasNoLeakingPiiDeep, redactText } from "@cognia/redact"

import { getExternalAgentManager } from "@/lib/ai/agent/external/manager"
import { getExternalAgentExecutionBlockReason } from "@/lib/ai/agent/external/config-normalizer"
import { supportsExternalAgents } from "@/lib/ai/agent/external/agent-transport"
import { resolveBashPermission, type Ruleset } from "@/lib/claude/permissions/ruleset"
import { checkFileAccess, normalizeFsPath } from "@/lib/files/permissions"
import type {
  AcpPermissionRequest,
  AcpPermissionResponse,
  ExternalAgentInstance,
} from "@/types/agent/external-agent"

import type { IssueLoopDriver } from "../workflow/issue-loop"
import { ISSUE_LOOP_PERMISSION_RULESET } from "./sidecar-driver"
import { SidecarIssueLoopDriver } from "./sidecar-driver"
import { buildIssueSystemPrompt, buildIssueUserPrompt, extractSummary } from "./system-prompt"

const ISSUE_LOOP_TIMEOUT_MS = 60 * 60_000

type ExternalAgentManagerPort = Pick<
  ReturnType<typeof getExternalAgentManager>,
  "getAgent" | "connect" | "execute"
>

export interface ExternalAgentIssueLoopDriverDeps {
  manager?: ExternalAgentManagerPort
  runtimeSupportsExternalAgents?: () => boolean
}

function permissionResponse(
  request: AcpPermissionRequest,
  granted: boolean,
  reason: string
): AcpPermissionResponse {
  const allowOnce = request.options?.find((option) => option.kind === "allow_once")
  return {
    requestId: request.requestId ?? request.id,
    granted,
    reason,
    rememberChoice: false,
    scope: "once",
    ...(granted && allowOnce ? { optionId: allowOnce.optionId } : {}),
  }
}

function commandFrom(request: AcpPermissionRequest): string | null {
  const raw = request.rawInput
  if (!raw) return null
  const command = raw.command ?? raw.cmd
  if (typeof command === "string" && command.trim()) return command
  if (
    Array.isArray(command) &&
    command.length > 0 &&
    command.every((part) => typeof part === "string")
  ) {
    return command.join(" ")
  }
  return null
}

function isShellRequest(request: AcpPermissionRequest): boolean {
  const tool = request.toolInfo.name.toLowerCase()
  return (
    request.kind === "execute" ||
    request.kind === "terminal" ||
    ["bash", "shell", "terminal", "command", "exec"].some((name) => tool.includes(name))
  )
}

function isWriteRequest(request: AcpPermissionRequest): boolean {
  const tool = request.toolInfo.name.toLowerCase()
  return (
    request.kind === "file_write" ||
    request.kind === "write" ||
    tool === "edit" ||
    tool === "write" ||
    tool.includes("apply_patch") ||
    tool.includes("file_write")
  )
}

function isReadRequest(request: AcpPermissionRequest): boolean {
  const tool = request.toolInfo.name.toLowerCase()
  return request.kind === "file_read" || request.kind === "read" || tool === "read"
}

function pathsFrom(request: AcpPermissionRequest): string[] {
  const paths = new Set<string>()
  for (const location of request.locations ?? []) {
    if (typeof location.path === "string" && location.path.trim()) paths.add(location.path)
  }
  const raw = request.rawInput
  if (!raw) return [...paths]
  for (const key of ["path", "filePath", "file_path", "destPath", "destination"]) {
    const value = raw[key]
    if (typeof value === "string" && value.trim()) paths.add(value)
  }
  if (raw.fileChanges && typeof raw.fileChanges === "object" && !Array.isArray(raw.fileChanges)) {
    for (const path of Object.keys(raw.fileChanges)) paths.add(path)
  }
  return [...paths]
}

function resolvePermissionPath(path: string, workspacePath: string): string {
  const normalized = normalizeFsPath(path)
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.startsWith("//")
  ) {
    return normalized
  }
  return normalizeFsPath(`${normalizeFsPath(workspacePath)}/${normalized}`)
}

function isConfinedPath(path: string, operation: "read" | "write", workspacePath: string): boolean {
  return checkFileAccess(resolvePermissionPath(path, workspacePath), operation, {
    allowedRoots: [workspacePath],
    deniedGlobs: ["**/.git/**", ".git/**"],
  }).allowed
}

/**
 * Pure, fail-closed permission decision shared by every External Agent used by
 * GitHub Delivery. The response is always single-use and never remembered.
 */
export function decideIssueLoopPermission(
  request: AcpPermissionRequest,
  workspacePath: string
): AcpPermissionResponse {
  if (
    request.rawInput?.permissionMode === "bypassPermissions" ||
    request.rawInput?.bypassPermissions === true
  ) {
    return permissionResponse(request, false, "Bypass permissions are disabled for Issue Loop.")
  }
  if (request.toolInfo.name.toLowerCase() === "request_permissions") {
    return permissionResponse(request, false, "Permission escalation is disabled for Issue Loop.")
  }

  const rawCwd = request.rawInput?.cwd
  if (rawCwd !== undefined) {
    if (typeof rawCwd !== "string" || !isConfinedPath(rawCwd, "read", workspacePath)) {
      return permissionResponse(request, false, "Command working directory escapes the workspace.")
    }
  }

  if (isShellRequest(request)) {
    if (typeof rawCwd !== "string" || !rawCwd.trim()) {
      return permissionResponse(request, false, "Command working directory cannot be proven.")
    }
    const command = commandFrom(request)
    if (!command) {
      return permissionResponse(request, false, "Shell input cannot be inspected.")
    }
    const verdict = resolveBashPermission(command, [
      ISSUE_LOOP_PERMISSION_RULESET as unknown as Ruleset,
    ]).verdict
    return verdict === "deny"
      ? permissionResponse(request, false, "Remote Git operations are host-owned.")
      : permissionResponse(request, true, "Safe workspace command approved once.")
  }

  if (isWriteRequest(request) || isReadRequest(request)) {
    const paths = pathsFrom(request)
    if (paths.length === 0) {
      return permissionResponse(request, false, "File location cannot be proven.")
    }
    const operation = isWriteRequest(request) ? "write" : "read"
    const allConfined = paths.every((path) => isConfinedPath(path, operation, workspacePath))
    return allConfined
      ? permissionResponse(request, true, "Workspace file operation approved once.")
      : permissionResponse(request, false, "File operation escapes the delivery workspace.")
  }

  return permissionResponse(request, false, "Tool is not approved for Issue Loop.")
}

function assertExecutionCapabilities(instance: ExternalAgentInstance): void {
  if (instance.validity?.executable !== true) {
    throw new Error(
      `External agent "${instance.config.id}" is not executable: ${
        instance.validity?.blockingReason ?? "runtime validity is unavailable"
      }`
    )
  }
  const capabilities = instance.capabilities ?? instance.config.capabilities
  if (
    capabilities?.toolExecution !== true ||
    capabilities.fileOperations !== true ||
    capabilities.multiTurn !== true
  ) {
    throw new Error(
      `External agent "${instance.config.id}" lacks required tool, write, or recovery capabilities.`
    )
  }
  const resume = instance.validity.sessionExtensions["session/resume"].state
  if (instance.config.protocol !== "codex-app-server" && resume !== "supported") {
    throw new Error(`External agent "${instance.config.id}" lacks session resume capability.`)
  }
}

export class ExternalAgentIssueLoopDriver implements IssueLoopDriver {
  private readonly manager: ExternalAgentManagerPort
  private readonly runtimeSupportsExternalAgents: () => boolean

  constructor(deps: ExternalAgentIssueLoopDriverDeps = {}) {
    this.manager = deps.manager ?? getExternalAgentManager()
    this.runtimeSupportsExternalAgents =
      deps.runtimeSupportsExternalAgents ?? supportsExternalAgents
  }

  async run(opts: Parameters<IssueLoopDriver["run"]>[0]) {
    const externalAgentId = opts.externalAgentId
    if (!externalAgentId) {
      throw new Error("ExternalAgentIssueLoopDriver requires externalAgentId.")
    }

    const configured = this.manager.getAgent(externalAgentId)
    if (!configured) throw new Error(`External agent not found: ${externalAgentId}`)
    const blocked = getExternalAgentExecutionBlockReason(
      configured.config,
      this.runtimeSupportsExternalAgents()
    )
    if (blocked)
      throw new Error(`External agent "${externalAgentId}" is not executable: ${blocked}`)

    if (configured.connectionStatus !== "connected") {
      await this.manager.connect(externalAgentId)
    }
    const connected = this.manager.getAgent(externalAgentId)
    if (!connected) throw new Error(`External agent disappeared after connect: ${externalAgentId}`)
    assertExecutionCapabilities(connected)

    const systemPrompt = buildIssueSystemPrompt()
    const rawUserPrompt = buildIssueUserPrompt({
      repoFullName: opts.repoFullName,
      issueNumber: opts.issueNumber,
      issueTitle: opts.issueTitle,
      issueBody: opts.issueBody,
    })
    const userPrompt = redactText(rawUserPrompt).redacted
    if (!hasNoLeakingPiiDeep({ systemPrompt, userPrompt })) {
      throw new Error("Issue Loop prompt blocked by the outbound PII gate.")
    }

    const seenPermissionRequests = new Set<string>()
    const onPermissionRequest = async (
      request: AcpPermissionRequest
    ): Promise<AcpPermissionResponse> => {
      const requestId = request.requestId ?? request.id
      if (seenPermissionRequests.has(requestId)) {
        return permissionResponse(request, false, "Permission replay is not allowed.")
      }
      seenPermissionRequests.add(requestId)
      return decideIssueLoopPermission(request, opts.workspacePath)
    }

    const execution = await this.manager.execute(externalAgentId, userPrompt, {
      workingDirectory: opts.workspacePath,
      systemPrompt,
      permissionMode: "default",
      timeout: ISSUE_LOOP_TIMEOUT_MS,
      maxSteps: 60,
      signal: opts.signal,
      onPermissionRequest,
      traceContext: {
        traceId: opts.workflowRunId,
        spanId: opts.workflowStepId,
        metadata: {
          workflowRunId: opts.workflowRunId,
          workflowStepId: opts.workflowStepId,
          githubRepo: opts.repoFullName,
          githubIssueNumber: opts.issueNumber,
        },
      },
    })
    if (!execution.success) {
      throw new Error(
        `External agent "${externalAgentId}" failed: ${
          execution.error ?? execution.errorCode ?? "unknown execution error"
        }`
      )
    }

    return {
      summary: extractSummary(execution.finalResponse),
      durationMs: execution.duration,
      driverId: externalAgentId,
    }
  }
}

export interface SelectableIssueLoopDriverDeps {
  sidecar?: IssueLoopDriver
  external?: IssueLoopDriver
}

/**
 * The production Issue Loop driver. Selection stays inside this adapter:
 * workflow, workspace, and ExternalAgentManager remain unaware of the choice.
 */
export class SelectableIssueLoopDriver implements IssueLoopDriver {
  private readonly sidecar: IssueLoopDriver
  private readonly external: IssueLoopDriver

  constructor(deps: SelectableIssueLoopDriverDeps = {}) {
    this.sidecar = deps.sidecar ?? new SidecarIssueLoopDriver()
    this.external = deps.external ?? new ExternalAgentIssueLoopDriver()
  }

  run(opts: Parameters<IssueLoopDriver["run"]>[0]) {
    return opts.externalAgentId ? this.external.run(opts) : this.sidecar.run(opts)
  }
}
