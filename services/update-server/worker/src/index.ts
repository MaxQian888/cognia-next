import type {
  D1Database,
  ExportedHandler,
  Request,
  Response as WorkerResponse,
  ResponseInit,
} from "@cloudflare/workers-types"

// These constructors are provided by the Worker runtime, whose Fetch types
// differ from the DOM types used by the enclosing application.
type Response = WorkerResponse
declare const Response: typeof import("@cloudflare/workers-types").Response
/**
 * Cognia update control plane.
 *
 * Three client-facing endpoints and one admin surface:
 *
 *   GET  /v1/catalog?channel=…                       signed metadata bundle
 *   GET  /v1/tauri/:target/:arch/:currentVersion     Tauri updater manifest
 *   GET  /v1/rollout/:kind/:assetId/:target/:arch/:currentVersion
 *                                                    live rollout answer
 *   POST /v1/admin/…                                 stage / promote / pause /
 *                                                    abort / revoke / publish
 *
 * The Worker signs nothing. CI signs the catalog bundle offline with keys this
 * service never sees, and the Worker only decides which signed bundle is
 * current. That is what keeps a compromise of this Worker from being a
 * compromise of every install: the client verifies the bundle against a root
 * it shipped with, so a Worker that serves a forged bundle is simply refused.
 *
 * The Tauri endpoint is the one place a fast kill switch matters, because the
 * desktop is the only in-app installer. `abort` there takes effect on the next
 * check without waiting for a re-signed catalog. Tauri still verifies minisign
 * on the package itself, so an aborted-but-served release could not have been
 * installed silently either way.
 *
 * The rollout endpoint is the same kill switch for everything else that
 * installs itself, which today is the always-on host (ADR-0224 A10). A host
 * installs only a release that is BOTH in the signed catalog (which pins the
 * artifact) AND rolling here for its bucket, so this answer can hold a
 * release back but never put one forward: it names a version and a digest,
 * and a host that finds either missing from its verified catalog ignores it.
 */

export interface Env {
  UPDATE_DB: D1Database
  UPDATE_ADMIN_SECRET: string
  CATALOG_CACHE_SECONDS?: string
}

type ReleaseState = "staged" | "rolling" | "paused" | "aborted" | "revoked"

interface ReleaseRow {
  id: string
  asset_id: string
  kind: string
  channel: string
  version: string
  target: string
  arch: string
  state: ReleaseState
  rollout: number
  criticality: string
  notes: string | null
  pub_date: string
  url: string | null
  signature: string | null
  /** Archive sha256 or image `sha256:` digest, for releases a host installs. */
  digest: string | null
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" }

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { ...JSON_HEADERS, ...(init.headers ?? {}) },
  })
}

function problem(status: number, code: string, message: string): Response {
  return json({ error: code, message }, { status })
}

/** Constant-time bearer comparison. A length mismatch is still a mismatch. */
function authorized(request: Request, env: Env): boolean {
  const header = request.headers.get("authorization") ?? ""
  const token = header.startsWith("Bearer ") ? header.slice(7) : ""
  const expected = env.UPDATE_ADMIN_SECRET ?? ""
  if (!expected || token.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i += 1) diff |= token.charCodeAt(i) ^ expected.charCodeAt(i)
  return diff === 0
}

/** Numeric semver compare tolerating a `v` prefix and a prerelease suffix. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre = ""] = v.replace(/^v/i, "").split("-", 2)
    const parts = core.split(".").map((n) => Number.parseInt(n, 10) || 0)
    while (parts.length < 3) parts.push(0)
    return { parts, pre }
  }
  const left = parse(a)
  const right = parse(b)
  for (let i = 0; i < 3; i += 1) {
    if (left.parts[i] !== right.parts[i]) return left.parts[i] < right.parts[i] ? -1 : 1
  }
  if (left.pre === right.pre) return 0
  if (!left.pre) return 1
  if (!right.pre) return -1
  return left.pre < right.pre ? -1 : 1
}

/** Channels a device on `channel` may see, widest last. */
export function visibleChannels(channel: string): string[] {
  if (channel === "canary") return ["stable", "beta", "canary"]
  if (channel === "beta") return ["stable", "beta"]
  return ["stable"]
}

/** Whether a device's cohort bucket is inside the release's rollout window. */
export function inRollout(bucket: number, rollout: number): boolean {
  if (rollout >= 100) return true
  if (rollout <= 0) return false
  return bucket < (rollout / 100) * 10_000
}

function parseBucket(raw: string | null): number {
  const value = Number.parseInt(raw ?? "", 10)
  if (!Number.isInteger(value) || value < 0 || value >= 10_000) return 0
  return value
}

/**
 * Kinds that need a pinned package before they can be staged, and what pins
 * it. Finding a missing package at promote time means finding it out in
 * front of users.
 */
export function stageProblem(body: {
  kind: string
  url?: string
  signature?: string
  digest?: string
}): string | null {
  if (body.kind === "desktop" && (!body.url || !body.signature)) {
    return "a desktop release needs both url and signature"
  }
  if (body.kind === "host-server") {
    if (!body.url) return "a host release needs its archive url or image repository"
    if (!/^(sha256:)?[0-9a-f]{64}$/.test(body.digest ?? "")) {
      return "a host release needs its archive sha256 or image sha256: digest"
    }
  }
  return null
}

interface RollingQuery {
  kind: string
  assetId: string
  target: string
  arch: string
  currentVersion: string
  channel: string
  bucket: number
  /** Someone asked for this update: skips the percentage, not the state. */
  manual?: boolean
}

/** The newest rolling release of one asset this caller may move to now. */
async function bestRolling(env: Env, query: RollingQuery): Promise<ReleaseRow | null> {
  const channels = visibleChannels(query.channel)
  const placeholders = channels.map((_, i) => `?${i + 5}`).join(", ")
  const { results } = await env.UPDATE_DB.prepare(
    `SELECT * FROM releases
      WHERE kind = ?1 AND state = 'rolling'
        AND target = ?2 AND arch = ?3 AND asset_id = ?4
        AND channel IN (${placeholders})`
  )
    .bind(query.kind, query.target, query.arch, query.assetId, ...channels)
    .all<ReleaseRow>()
  const eligible = (results ?? [])
    .filter((row) => compareVersions(row.version, query.currentVersion) > 0)
    .filter((row) => query.manual || inRollout(query.bucket, row.rollout))
    .sort((a, b) => compareVersions(b.version, a.version))
  return eligible[0] ?? null
}

// ── Client endpoints ───────────────────────────────────────────────────────

async function handleCatalog(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const channel = url.searchParams.get("channel") ?? "stable"
  if (!["stable", "beta", "canary"].includes(channel)) {
    return problem(400, "bad_channel", "unknown channel")
  }

  const row = await env.UPDATE_DB.prepare("SELECT bundle FROM catalogs WHERE channel = ?1")
    .bind(channel)
    .first<{ bundle: string }>()

  // No published bundle is not an error. A client that gets 204 falls back to
  // its own sources and installs nothing on unverified metadata.
  if (!row) return new Response(null, { status: 204 })

  const maxAge = Number.parseInt(env.CATALOG_CACHE_SECONDS ?? "60", 10) || 60
  return new Response(row.bundle, {
    status: 200,
    headers: {
      ...JSON_HEADERS,
      "cache-control": `public, max-age=${maxAge}`,
      // The bundle is signed. Nothing here is trusted because it came from us.
      "x-content-type-options": "nosniff",
    },
  })
}

async function handleTauri(
  env: Env,
  target: string,
  arch: string,
  currentVersion: string,
  channel: string,
  bucket: number
): Promise<Response> {
  const best = await bestRolling(env, {
    kind: "desktop",
    assetId: "app",
    target,
    arch,
    currentVersion,
    channel,
    bucket,
  })
  // 204 is the Tauri updater's "you are current". Anything else makes the
  // desktop log an error on every check.
  if (!best || !best.url || !best.signature) return new Response(null, { status: 204 })

  return json({
    version: best.version,
    notes: best.notes ?? "",
    pub_date: best.pub_date,
    platforms: {
      [`${target}-${arch}`]: { signature: best.signature, url: best.url },
    },
  })
}

/**
 * The live rollout answer for an asset that installs itself. 204 means
 * nothing is rolling for this caller now, which is also what an aborted,
 * paused or revoked release answers.
 */
async function handleRollout(env: Env, query: RollingQuery): Promise<Response> {
  const best = await bestRolling(env, query)
  if (!best) return new Response(null, { status: 204 })
  return json(
    {
      version: best.version,
      channel: best.channel,
      criticality: best.criticality,
      rollout: best.rollout,
      digest: best.digest,
    },
    { headers: { "cache-control": "no-store" } }
  )
}

// ── Admin endpoints ────────────────────────────────────────────────────────

interface StageBody {
  assetId: string
  kind: string
  channel: string
  version: string
  target?: string
  arch?: string
  criticality?: string
  notes?: string
  pubDate?: string
  url?: string
  signature?: string
  digest?: string
}

async function logEvent(
  env: Env,
  releaseId: string,
  action: string,
  detail: string | null
): Promise<void> {
  await env.UPDATE_DB.prepare(
    "INSERT INTO release_events (release_id, action, detail, actor, created_at) VALUES (?1, ?2, ?3, ?4, ?5)"
  )
    .bind(releaseId, action, detail, "ci", Date.now())
    .run()
}

async function handleStage(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as StageBody | null
  if (!body?.assetId || !body.kind || !body.channel || !body.version) {
    return problem(400, "bad_request", "assetId, kind, channel and version are required")
  }
  const incomplete = stageProblem(body)
  if (incomplete) return problem(400, "incomplete_release", incomplete)

  const target = body.target ?? ""
  const arch = body.arch ?? ""
  const id = `${body.kind}:${body.assetId}:${body.channel}:${body.version}:${target}:${arch}`
  const now = Date.now()

  await env.UPDATE_DB.prepare(
    `INSERT INTO releases
      (id, asset_id, kind, channel, version, target, arch, state, rollout,
       criticality, notes, pub_date, url, signature, digest, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'staged', 0, ?8, ?9, ?10, ?11, ?12, ?14, ?13, ?13)
     ON CONFLICT(asset_id, kind, channel, version, target, arch) DO UPDATE SET
       criticality = excluded.criticality,
       notes = excluded.notes,
       pub_date = excluded.pub_date,
       url = excluded.url,
       signature = excluded.signature,
       digest = excluded.digest,
       updated_at = excluded.updated_at`
  )
    .bind(
      id,
      body.assetId,
      body.kind,
      body.channel,
      body.version,
      target,
      arch,
      body.criticality ?? "routine",
      body.notes ?? null,
      body.pubDate ?? new Date(now).toISOString(),
      body.url ?? null,
      body.signature ?? null,
      now,
      body.digest ?? null
    )
    .run()

  await logEvent(env, id, "stage", body.version)
  return json({ id, state: "staged" }, { status: 201 })
}

/** The only rollout ladder operators may step through. */
export const ROLLOUT_STEPS = [0, 1, 10, 25, 50, 100] as const

async function loadRelease(env: Env, id: string): Promise<ReleaseRow | null> {
  return env.UPDATE_DB.prepare("SELECT * FROM releases WHERE id = ?1").bind(id).first<ReleaseRow>()
}

async function handlePromote(request: Request, env: Env, id: string): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { rollout?: number }
  const release = await loadRelease(env, id)
  if (!release) return problem(404, "not_found", "no such release")
  if (release.state === "revoked" || release.state === "aborted") {
    return problem(409, "terminal_state", `a ${release.state} release cannot be promoted`)
  }
  const requested = body.rollout ?? ROLLOUT_STEPS[ROLLOUT_STEPS.indexOf(release.rollout as 0) + 1]
  if (typeof requested !== "number" || !ROLLOUT_STEPS.includes(requested as 0)) {
    return problem(400, "bad_rollout", `rollout must be one of ${ROLLOUT_STEPS.join(", ")}`)
  }
  // Each step is an explicit operator decision, and it only ever goes up.
  // Going down is `pause`, which is a different thing and is logged as one.
  if (requested < release.rollout) {
    return problem(409, "rollout_regression", "use pause or abort to stop a rollout")
  }

  await env.UPDATE_DB.prepare(
    "UPDATE releases SET state = 'rolling', rollout = ?2, updated_at = ?3 WHERE id = ?1"
  )
    .bind(id, requested, Date.now())
    .run()
  await logEvent(env, id, "promote", String(requested))
  return json({ id, state: "rolling", rollout: requested })
}

async function handleTransition(
  env: Env,
  id: string,
  action: "pause" | "abort" | "revoke"
): Promise<Response> {
  const release = await loadRelease(env, id)
  if (!release) return problem(404, "not_found", "no such release")
  const state: ReleaseState =
    action === "pause" ? "paused" : action === "abort" ? "aborted" : "revoked"
  // Aborted and revoked also drop the rollout to zero, so a later bug that
  // reads `state` wrongly still offers the release to nobody.
  const rollout = action === "pause" ? release.rollout : 0
  await env.UPDATE_DB.prepare(
    "UPDATE releases SET state = ?2, rollout = ?3, updated_at = ?4 WHERE id = ?1"
  )
    .bind(id, state, rollout, Date.now())
    .run()
  await logEvent(env, id, action, release.version)
  return json({ id, state, rollout })
}

async function handlePublishCatalog(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as {
    channel?: string
    bundle?: unknown
  } | null
  if (!body?.channel || !body.bundle) {
    return problem(400, "bad_request", "channel and bundle are required")
  }
  const bundle = body.bundle as { targets?: { signed?: { version?: number } } }
  const version = bundle?.targets?.signed?.version
  if (typeof version !== "number" || !Number.isInteger(version)) {
    return problem(400, "bad_bundle", "bundle.targets.signed.version must be an integer")
  }

  const existing = await env.UPDATE_DB.prepare(
    "SELECT targets_version FROM catalogs WHERE channel = ?1"
  )
    .bind(body.channel)
    .first<{ targets_version: number }>()

  // Refusing a non-increasing version at the edge as well as in the client:
  // a replayed bundle should not even be storable.
  if (existing && version <= existing.targets_version) {
    return problem(409, "rollback", "targets version must increase")
  }

  await env.UPDATE_DB.prepare(
    `INSERT INTO catalogs (channel, targets_version, bundle, updated_at)
     VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(channel) DO UPDATE SET
       targets_version = excluded.targets_version,
       bundle = excluded.bundle,
       updated_at = excluded.updated_at`
  )
    .bind(body.channel, version, JSON.stringify(body.bundle), Date.now())
    .run()

  return json({ channel: body.channel, targetsVersion: version }, { status: 201 })
}

async function handleAdmin(request: Request, env: Env, path: string[]): Promise<Response> {
  if (!authorized(request, env)) return problem(401, "unauthorized", "admin bearer required")
  if (request.method !== "POST") return problem(405, "method_not_allowed", "POST only")

  const [resource, ...rest] = path
  if (resource === "releases" && rest.length === 0) return handleStage(request, env)
  if (resource === "catalog") return handlePublishCatalog(request, env)
  if (resource === "releases" && rest.length === 2) {
    const [id, action] = rest
    if (action === "promote") return handlePromote(request, env, id)
    if (action === "pause" || action === "abort" || action === "revoke") {
      return handleTransition(env, id, action)
    }
  }
  return problem(404, "not_found", "unknown admin route")
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const segments = url.pathname.split("/").filter(Boolean)

    if (segments[0] !== "v1") return problem(404, "not_found", "unknown route")

    if (segments[1] === "catalog" && segments.length === 2) {
      if (request.method !== "GET") return problem(405, "method_not_allowed", "GET only")
      return handleCatalog(request, env)
    }

    // /v1/tauri/:target/:arch/:currentVersion
    if (segments[1] === "tauri" && segments.length === 5) {
      if (request.method !== "GET") return problem(405, "method_not_allowed", "GET only")
      return handleTauri(
        env,
        decodeURIComponent(segments[2]),
        decodeURIComponent(segments[3]),
        decodeURIComponent(segments[4]),
        url.searchParams.get("channel") ?? "stable",
        parseBucket(url.searchParams.get("bucket"))
      )
    }

    // /v1/rollout/:kind/:assetId/:target/:arch/:currentVersion
    if (segments[1] === "rollout" && segments.length === 7) {
      if (request.method !== "GET") return problem(405, "method_not_allowed", "GET only")
      const channel = url.searchParams.get("channel") ?? "stable"
      if (!["stable", "beta", "canary"].includes(channel)) {
        return problem(400, "bad_channel", "unknown channel")
      }
      const [kind, assetId, target, arch, currentVersion] = segments
        .slice(2)
        .map((s) => decodeURIComponent(s))
      return handleRollout(env, {
        kind,
        assetId,
        target,
        arch,
        currentVersion,
        channel,
        bucket: parseBucket(url.searchParams.get("bucket")),
        manual: url.searchParams.get("manual") === "1",
      })
    }

    // Release ids contain ':' separators, which arrive percent-encoded. Decode
    // before matching or every admin route on a real id answers 404.
    if (segments[1] === "admin") {
      return handleAdmin(
        request,
        env,
        segments.slice(2).map((s) => decodeURIComponent(s))
      )
    }

    return problem(404, "not_found", "unknown route")
  },
} satisfies ExportedHandler<Env>
