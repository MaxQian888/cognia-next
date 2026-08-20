"use client"

/**
 * Typed client for the self-hosted diagnostic service.
 *
 * Deliberately transport-agnostic: `fetchImpl` is injected because the WebView
 * cannot reach a user-configured host directly on any shell (see
 * `lib/network/platform-fetch.ts`), and because that is what makes the whole
 * surface testable without a server.
 *
 * The client does **not** own credentials. `grant` is a callback so a caller
 * can mint, cache, and refresh a 15-minute grant however it likes — the
 * console keeps one in memory, the settings card exchanges one per action.
 *
 * Large binary uploads on the desktop do **not** go through here: packaging a
 * crash bundle reads files the renderer cannot see, and pushing a
 * hundred-megabyte part across the IPC boundary to then push it out again is
 * two copies too many. That path lives in `src-tauri/src/crash/submit.rs`;
 * this client covers the console, the settings card, mobile submission, and
 * the support-report channel, all of which handle small payloads.
 */

import type {
  AuditEventRecord,
  CreateIncidentInput,
  CreateIncidentResponse,
  GrantResponse,
  IncidentGroupRecord,
  IncidentRecord,
  ListGroupsInput,
  ListIncidentsInput,
  SymbolRecord,
  TenantRecord,
  TriageGroupInput,
  UpdateTenantInput,
  UploadPartRecord,
  UploadProgressResponse,
  ArtifactKind,
} from "./types"

/** A `fetch`-compatible function. Narrower than `typeof fetch` on purpose. */
export type DiagnosticFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/**
 * A failure with the service's own machine-readable code.
 *
 * The service answers every error as `{"error":{"code":"..."}}` and never puts
 * anything else in the body, so `code` is the only thing worth branching on —
 * the UI maps it to a translated string rather than showing server prose.
 */
export class DiagnosticServiceError extends Error {
  readonly name = "DiagnosticServiceError"

  constructor(
    readonly code: string,
    readonly status: number,
    message?: string
  ) {
    super(message ?? code)
  }

  /** True when a grant is missing, malformed, or has aged out. */
  get isAuthFailure(): boolean {
    return this.status === 401
  }

  /** True when the grant is valid but sits below the route's required role. */
  get isForbidden(): boolean {
    return this.status === 403
  }

  /** True when intake is switched off and the caller should keep its spool. */
  get isIngestDisabled(): boolean {
    return this.code === "ingest_disabled"
  }
}

async function errorFrom(response: Response): Promise<DiagnosticServiceError> {
  let code = `http_${response.status}`
  try {
    const body = (await response.json()) as { error?: { code?: unknown } }
    if (typeof body?.error?.code === "string") code = body.error.code
  } catch {
    // A non-JSON body means a proxy or gateway answered, not the service.
    // The synthesized `http_<status>` code is more honest than inventing one.
  }
  return new DiagnosticServiceError(code, response.status)
}

/**
 * Normalize a user-typed base URL.
 *
 * Rejects anything that is not http(s) so a typo cannot turn into a
 * `file:`/`javascript:` request, and keeps the path prefix so a service hosted
 * under `https://host/diagnostics` works — `new URL("/v1/x", base)` would
 * silently discard that prefix, which is why every path below is joined
 * relative instead.
 */
export function normalizeServiceUrl(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) throw new Error("A diagnostic service URL is required")
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  const url = new URL(withScheme)
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("The diagnostic service URL must be http or https")
  }
  url.hash = ""
  url.search = ""
  return url.toString().replace(/\/+$/, "")
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue
    search.set(key, String(value))
  }
  const encoded = search.toString()
  return encoded ? `?${encoded}` : ""
}

export interface DiagnosticServiceClientOptions {
  baseUrl: string
  /** Resolves a bearer grant. Called per request so a cache can refresh. */
  grant: () => Promise<string>
  fetchImpl: DiagnosticFetch
}

export class DiagnosticServiceClient {
  private readonly baseUrl: string
  private readonly grant: () => Promise<string>
  private readonly fetchImpl: DiagnosticFetch

  constructor(options: DiagnosticServiceClientOptions) {
    this.baseUrl = normalizeServiceUrl(options.baseUrl)
    this.grant = options.grant
    this.fetchImpl = options.fetchImpl
  }

  // -- Triage console -------------------------------------------------------

  listGroups(input: ListGroupsInput = {}): Promise<IncidentGroupRecord[]> {
    return this.json<IncidentGroupRecord[]>(
      `/v1/groups${query({
        status: input.status,
        platform: input.platform,
        assignedTo: input.assignedTo,
        q: input.q,
        limit: input.limit,
        offset: input.offset,
      })}`
    )
  }

  getGroup(groupId: string): Promise<IncidentGroupRecord> {
    return this.json<IncidentGroupRecord>(`/v1/groups/${encodeURIComponent(groupId)}`)
  }

  /**
   * Apply a triage edit.
   *
   * `assignedTo: null` is serialized as an explicit null so the service
   * unassigns; omitting the key leaves the current assignee in place. Dropping
   * that distinction would make "unassign" impossible to express.
   */
  triageGroup(groupId: string, input: TriageGroupInput): Promise<IncidentGroupRecord> {
    const body: Record<string, unknown> = {}
    if (input.status !== undefined) body.status = input.status
    if (input.assignedTo !== undefined) body.assignedTo = input.assignedTo
    if (Object.keys(body).length === 0) {
      throw new DiagnosticServiceError("empty_triage_update", 400)
    }
    return this.json<IncidentGroupRecord>(`/v1/groups/${encodeURIComponent(groupId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  }

  listIncidents(input: ListIncidentsInput = {}): Promise<IncidentRecord[]> {
    return this.json<IncidentRecord[]>(
      `/v1/incidents${query({
        groupId: input.groupId,
        processingState: input.processingState,
        supportCode: input.supportCode,
        limit: input.limit,
        offset: input.offset,
      })}`
    )
  }

  getIncident(incidentId: string): Promise<IncidentRecord> {
    return this.json<IncidentRecord>(`/v1/incidents/${encodeURIComponent(incidentId)}`)
  }

  incidentAudit(incidentId: string, limit?: number): Promise<AuditEventRecord[]> {
    return this.json<AuditEventRecord[]>(
      `/v1/incidents/${encodeURIComponent(incidentId)}/audit${query({ limit })}`
    )
  }

  listArtifacts(incidentId: string): Promise<UploadPartRecord[]> {
    return this.json<UploadPartRecord[]>(
      `/v1/incidents/${encodeURIComponent(incidentId)}/artifacts`
    )
  }

  /**
   * Pull one stored artifact back, decrypted.
   *
   * Minidumps additionally require the tenant's `rawMinidumpAccessEnabled`
   * opt-in and answer `raw_minidump_access_disabled` otherwise. Every call is
   * recorded in the incident's audit trail against the operator's identity, so
   * this is never a quiet read.
   */
  async downloadArtifact(incidentId: string, partNumber: number): Promise<Uint8Array> {
    const response = await this.send(
      `/v1/incidents/${encodeURIComponent(incidentId)}/artifacts/${partNumber}`
    )
    if (!response.ok) throw await errorFrom(response)
    return new Uint8Array(await response.arrayBuffer())
  }

  // -- Tenant policy (admin) ------------------------------------------------

  getTenant(): Promise<TenantRecord> {
    return this.json<TenantRecord>("/v1/admin/tenant")
  }

  updateTenant(input: UpdateTenantInput): Promise<TenantRecord> {
    return this.json<TenantRecord>("/v1/admin/tenant", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    })
  }

  listSymbols(buildId?: string): Promise<SymbolRecord[]> {
    return this.json<SymbolRecord[]>(`/v1/admin/symbols${query({ buildId })}`)
  }

  // -- Submission -----------------------------------------------------------

  createIncident(input: CreateIncidentInput): Promise<CreateIncidentResponse> {
    return this.json<CreateIncidentResponse>("/v1/incidents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    })
  }

  uploadProgress(incidentId: string): Promise<UploadProgressResponse> {
    return this.json<UploadProgressResponse>(
      `/v1/incidents/${encodeURIComponent(incidentId)}/parts`
    )
  }

  /**
   * Push one part. `sha256` must be the hex digest of `body` as sent — the
   * service recomputes it and answers `part_checksum_mismatch` on a mismatch,
   * which is what makes a resumed upload safe to retry blindly.
   */
  uploadPart(
    incidentId: string,
    partNumber: number,
    body: Uint8Array,
    sha256: string,
    artifactKind: ArtifactKind = "attachment"
  ): Promise<UploadPartRecord> {
    return this.json<UploadPartRecord>(
      `/v1/incidents/${encodeURIComponent(incidentId)}/parts/${partNumber}`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          "x-part-sha256": sha256,
          "x-artifact-kind": artifactKind,
        },
        // A fresh copy of the buffer: `BodyInit` keeps a live view, and the
        // caller is free to reuse its scratch array for the next part.
        body: new Uint8Array(body).slice().buffer as ArrayBuffer,
      }
    )
  }

  completeUpload(incidentId: string): Promise<IncidentRecord> {
    return this.json<IncidentRecord>(`/v1/incidents/${encodeURIComponent(incidentId)}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
  }

  async cancelUpload(incidentId: string): Promise<void> {
    await this.json<void>(`/v1/incidents/${encodeURIComponent(incidentId)}/cancel`, {
      method: "POST",
    })
  }

  /** Block processing and schedule immediate deletion. Never 503s on intake. */
  async withdrawConsent(incidentId: string): Promise<void> {
    await this.json<void>(`/v1/incidents/${encodeURIComponent(incidentId)}/withdraw`, {
      method: "POST",
    })
  }

  async deleteIncident(incidentId: string): Promise<void> {
    await this.json<void>(`/v1/incidents/${encodeURIComponent(incidentId)}`, { method: "DELETE" })
  }

  // -- Plumbing -------------------------------------------------------------

  private async send(path: string, init: RequestInit = {}): Promise<Response> {
    const grant = await this.grant()
    if (!grant) throw new DiagnosticServiceError("grant_required", 401)
    const headers = new Headers(init.headers)
    headers.set("authorization", `Bearer ${grant}`)
    if (!headers.has("accept")) headers.set("accept", "application/json")
    return this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers })
  }

  private async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.send(path, init)
    if (!response.ok) throw await errorFrom(response)
    if (response.status === 204) return undefined as T
    return (await response.json()) as T
  }
}

/**
 * Exchange an identity-provider session for a grant.
 *
 * Standalone rather than a client method because it is the one call that has
 * no grant yet, and because the settings card needs it before a client exists.
 * Never behind the intake switch — see the service's router comment.
 */
export async function exchangeOidcGrant(options: {
  baseUrl: string
  sessionToken: string
  installationId: string
  fetchImpl: DiagnosticFetch
}): Promise<GrantResponse> {
  const base = normalizeServiceUrl(options.baseUrl)
  const response = await options.fetchImpl(`${base}/v1/grants/oidc`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      sessionToken: options.sessionToken,
      installationId: options.installationId,
    }),
  })
  if (!response.ok) throw await errorFrom(response)
  return (await response.json()) as GrantResponse
}
