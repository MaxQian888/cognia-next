import { localTransport } from "@/lib/tauri/transport-instance"

export type GitHubRunnerState =
  "dispatching" | "queued" | "starting" | "ready" | "stopping" | "stopped" | "failed" | "unknown"

export interface GitHubRunnerRequest {
  repository: string
  workflowRef: string
  hostImage: string
  agentBundleImage: string
  developmentImage: string
  signalingUrl: string
  lifetimeMinutes: number
  label: string
}

export type GitHubRunnerPreflightRequest = Pick<GitHubRunnerRequest, "repository" | "workflowRef">
export type GitHubRunnerPreflightCode =
  | "ok"
  | "not_checked"
  | "invalid_repository"
  | "invalid_ref"
  | "cli_unavailable"
  | "account_unavailable"
  | "repository_unavailable"
  | "repository_not_writable"
  | "repository_inactive"
  | "branch_unavailable"
  | "workflow_unavailable"
  | "workflow_inactive"
  | "templates_unavailable"
  | "templates_mismatch"
  | "timeout"
export interface GitHubRunnerPreflight {
  ready: boolean
  checks: {
    step: "cli" | "account" | "repository" | "branch" | "workflow" | "templates"
    status: "passed" | "failed" | "skipped"
    code: GitHubRunnerPreflightCode
    file?: string
  }[]
  actorLogin?: string
  commit?: string
}

/** Accept a repository link without accepting credentials, other hosts or subpages. */
export function normalizeRunnerRepository(value: string): string | undefined {
  let repository = value.trim()
  if (/^https:\/\//i.test(repository)) {
    try {
      const url = new URL(repository)
      if (
        url.hostname !== "github.com" ||
        url.port ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        return
      repository = url.pathname
        .replace(/^\//, "")
        .replace(/\/$/, "")
        .replace(/\.git$/, "")
    } catch {
      return
    }
  }
  return /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(repository) &&
    repository.split("/").every((part) => part.length <= 100 && part !== "." && part !== "..")
    ? repository
    : undefined
}

export interface GitHubRunnerLease {
  id: string
  repository: string
  workflowRef: string
  label: string
  state: GitHubRunnerState
  runId?: number | null
  runUrl?: string | null
  createdAt: number
  expiresAt?: number | null
  error?: string | null
  hostId?: string | null
}

export type RunnerValidationField = keyof GitHubRunnerRequest

/** Public workflow inputs only. Secrets are resolved exclusively by the native owner. */
export function validateRunnerRequest(request: GitHubRunnerRequest): RunnerValidationField[] {
  const errors: RunnerValidationField[] = []
  if (
    !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(request.repository) ||
    request.repository.split("/").some((part) => part.length > 100 || part === "." || part === "..")
  )
    errors.push("repository")
  if (
    !request.workflowRef ||
    request.workflowRef.length > 200 ||
    !/^[A-Za-z0-9._/][A-Za-z0-9._/-]*$/.test(request.workflowRef) ||
    request.workflowRef.includes("..")
  )
    errors.push("workflowRef")
  for (const field of ["hostImage", "agentBundleImage", "developmentImage"] as const) {
    if (!/^[a-z0-9][a-z0-9./:_-]{0,254}@sha256:[a-f0-9]{64}$/.test(request[field]))
      errors.push(field)
  }
  try {
    const url = new URL(request.signalingUrl)
    if (
      url.protocol !== "wss:" ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.hash ||
      url.search
    )
      errors.push("signalingUrl")
  } catch {
    errors.push("signalingUrl")
  }
  if (
    !Number.isInteger(request.lifetimeMinutes) ||
    request.lifetimeMinutes < 10 ||
    request.lifetimeMinutes > 330
  )
    errors.push("lifetimeMinutes")
  if (
    !request.label.trim() ||
    new TextEncoder().encode(request.label).length > 120 ||
    /\p{Cc}/u.test(request.label)
  )
    errors.push("label")
  return errors
}

/** Always call the local owner, even while the desktop drives a remote runner. */
export const githubRunnerClient = {
  preflight: (request: GitHubRunnerPreflightRequest) =>
    localTransport.call<GitHubRunnerPreflight>("github_runner_preflight", { request }),
  create: (request: GitHubRunnerRequest) =>
    localTransport.call<GitHubRunnerLease>("github_runner_create", { request }),
  list: () => localTransport.call<GitHubRunnerLease[]>("github_runner_list", {}),
  refresh: (id: string) => localTransport.call<GitHubRunnerLease>("github_runner_refresh", { id }),
  cancel: (id: string) => localTransport.call<GitHubRunnerLease>("github_runner_cancel", { id }),
  pairing: (id: string) => localTransport.call<string>("github_runner_pairing", { id }),
}

const LINK_KEY = "cognia:github-runner-host-links:v1"
const REQUEST_KEY = "cognia:github-runner-create-config:v1"
const MAX_REQUEST_LENGTH = 8192
const REQUEST_STRINGS = [
  "repository",
  "workflowRef",
  "hostImage",
  "agentBundleImage",
  "developmentImage",
  "signalingUrl",
  "label",
] as const

function publicRunnerRequest(value: unknown): GitHubRunnerRequest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const input = value as Record<string, unknown>
  if (
    REQUEST_STRINGS.some((field) => typeof input[field] !== "string" || input[field].length > 2048)
  )
    return
  if (typeof input.lifetimeMinutes !== "number") return
  // Pick known public fields explicitly; never persist credentials or extra native metadata.
  const request = Object.fromEntries(
    REQUEST_STRINGS.map((field) => [field, input[field]])
  ) as unknown as GitHubRunnerRequest
  request.lifetimeMinutes = input.lifetimeMinutes
  if (validateRunnerRequest(request).length || JSON.stringify(request).length > MAX_REQUEST_LENGTH)
    return
  return request
}

export function loadRunnerCreateConfig(): GitHubRunnerRequest | undefined {
  try {
    const raw = localStorage.getItem(REQUEST_KEY)
    if (!raw || raw.length > MAX_REQUEST_LENGTH) return
    return publicRunnerRequest(JSON.parse(raw))
  } catch {
    return
  }
}

/** Best-effort public form preset; unavailable storage must not prevent dispatch. */
export function saveRunnerCreateConfig(value: GitHubRunnerRequest): boolean {
  const request = publicRunnerRequest(value)
  if (!request) return false
  try {
    localStorage.setItem(REQUEST_KEY, JSON.stringify(request))
    return true
  } catch {
    return false
  }
}

/** Reconnection metadata only; pairing material stays in the shared credential vault. */
export function runnerHostLinks(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(LINK_KEY) ?? "{}")
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).filter(
        ([key, value]) => key.length <= 128 && typeof value === "string" && value.length <= 128
      )
    )
  } catch {
    return {}
  }
}

export function linkRunnerHost(leaseId: string, hostId: string): void {
  localStorage.setItem(LINK_KEY, JSON.stringify({ ...runnerHostLinks(), [leaseId]: hostId }))
}

export function runnerRunUrl(lease: GitHubRunnerLease): string | undefined {
  // Build from verified coordinates; never navigate to a backend diagnostic URL.
  return /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(lease.repository) &&
    Number.isSafeInteger(lease.runId) &&
    lease.runId! > 0
    ? `https://github.com/${lease.repository}/actions/runs/${lease.runId}`
    : undefined
}
