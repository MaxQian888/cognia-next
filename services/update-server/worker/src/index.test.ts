import { env } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"

import worker, {
  compareVersions,
  inRollout,
  ROLLOUT_STEPS,
  visibleChannels,
  type Env,
} from "./index"

// `cloudflare:test` types `env` from the generated Cloudflare bindings, which
// this repo does not generate. One cast here beats one at every call site.
const testEnv = env as unknown as Env
const db = () => testEnv.UPDATE_DB

const ADMIN = { authorization: "Bearer test-admin-secret" }

async function migrate() {
  await db().exec(
    "CREATE TABLE IF NOT EXISTS releases (id TEXT PRIMARY KEY, asset_id TEXT NOT NULL, kind TEXT NOT NULL, channel TEXT NOT NULL, version TEXT NOT NULL, target TEXT NOT NULL DEFAULT '', arch TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT 'staged', rollout INTEGER NOT NULL DEFAULT 0, criticality TEXT NOT NULL DEFAULT 'routine', notes TEXT, pub_date TEXT NOT NULL, url TEXT, signature TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"
  )
  await db().exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS releases_identity ON releases (asset_id, kind, channel, version, target, arch)"
  )
  await db().exec(
    "CREATE TABLE IF NOT EXISTS catalogs (channel TEXT PRIMARY KEY, targets_version INTEGER NOT NULL, bundle TEXT NOT NULL, updated_at INTEGER NOT NULL)"
  )
  await db().exec(
    "CREATE TABLE IF NOT EXISTS release_events (id INTEGER PRIMARY KEY AUTOINCREMENT, release_id TEXT NOT NULL, action TEXT NOT NULL, detail TEXT, actor TEXT, created_at INTEGER NOT NULL)"
  )
  await db().exec("DELETE FROM releases")
  await db().exec("DELETE FROM catalogs")
  await db().exec("DELETE FROM release_events")
}

function call(path: string, init: RequestInit = {}) {
  return worker.fetch(new Request(`https://update.test${path}`, init), testEnv)
}

async function stageDesktop(version: string, overrides: Record<string, unknown> = {}) {
  const res = await call("/v1/admin/releases", {
    method: "POST",
    headers: { ...ADMIN, "content-type": "application/json" },
    body: JSON.stringify({
      assetId: "app",
      kind: "desktop",
      channel: "stable",
      version,
      target: "darwin",
      arch: "aarch64",
      url: `https://example.test/${version}.tar.gz`,
      signature: "sig",
      pubDate: "2026-01-01T00:00:00Z",
      ...overrides,
    }),
  })
  const body = (await res.json()) as { id: string }
  return body.id
}

beforeEach(migrate)

describe("pure helpers", () => {
  it("orders versions numerically, not lexically", () => {
    expect(compareVersions("0.10.0", "0.9.0")).toBe(1)
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0)
  })

  it("ranks a release above its own prerelease", () => {
    expect(compareVersions("1.0.0", "1.0.0-beta.1")).toBe(1)
  })

  it("widens visible channels downward only", () => {
    expect(visibleChannels("stable")).toEqual(["stable"])
    expect(visibleChannels("beta")).toEqual(["stable", "beta"])
    expect(visibleChannels("canary")).toEqual(["stable", "beta", "canary"])
  })

  it("offers a 1 percent rollout to the first hundred buckets only", () => {
    expect(inRollout(99, 1)).toBe(true)
    expect(inRollout(100, 1)).toBe(false)
    expect(inRollout(9999, 100)).toBe(true)
    expect(inRollout(0, 0)).toBe(false)
  })
})

describe("GET /v1/tauri", () => {
  it("answers 204 when nothing is published", async () => {
    const res = await call("/v1/tauri/darwin/aarch64/0.1.0")
    expect(res.status).toBe(204)
  })

  it("answers 204 for a staged release that was never promoted", async () => {
    await stageDesktop("0.2.0")
    const res = await call("/v1/tauri/darwin/aarch64/0.1.0")
    expect(res.status).toBe(204)
  })

  it("serves a promoted release with the Tauri manifest shape", async () => {
    const id = await stageDesktop("0.2.0")
    await call(`/v1/admin/releases/${encodeURIComponent(id)}/promote`, {
      method: "POST",
      headers: { ...ADMIN, "content-type": "application/json" },
      body: JSON.stringify({ rollout: 100 }),
    })
    const res = await call("/v1/tauri/darwin/aarch64/0.1.0")
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      version: string
      platforms: Record<string, { url: string; signature: string }>
    }
    expect(body.version).toBe("0.2.0")
    expect(body.platforms["darwin-aarch64"].url).toContain("0.2.0")
  })

  it("never offers a version the caller already runs", async () => {
    const id = await stageDesktop("0.2.0")
    await call(`/v1/admin/releases/${encodeURIComponent(id)}/promote`, {
      method: "POST",
      headers: { ...ADMIN, "content-type": "application/json" },
      body: JSON.stringify({ rollout: 100 }),
    })
    expect((await call("/v1/tauri/darwin/aarch64/0.2.0")).status).toBe(204)
  })

  it("keeps a 1 percent rollout away from a device outside the cohort", async () => {
    const id = await stageDesktop("0.2.0")
    await call(`/v1/admin/releases/${encodeURIComponent(id)}/promote`, {
      method: "POST",
      headers: { ...ADMIN, "content-type": "application/json" },
      body: JSON.stringify({ rollout: 1 }),
    })
    expect((await call("/v1/tauri/darwin/aarch64/0.1.0?bucket=50")).status).toBe(200)
    expect((await call("/v1/tauri/darwin/aarch64/0.1.0?bucket=5000")).status).toBe(204)
  })

  it("hides a beta release from a stable device", async () => {
    const id = await stageDesktop("0.3.0", { channel: "beta" })
    await call(`/v1/admin/releases/${encodeURIComponent(id)}/promote`, {
      method: "POST",
      headers: { ...ADMIN, "content-type": "application/json" },
      body: JSON.stringify({ rollout: 100 }),
    })
    expect((await call("/v1/tauri/darwin/aarch64/0.1.0")).status).toBe(204)
    expect((await call("/v1/tauri/darwin/aarch64/0.1.0?channel=beta")).status).toBe(200)
  })

  it("stops serving an aborted release immediately", async () => {
    const id = await stageDesktop("0.2.0")
    const encoded = encodeURIComponent(id)
    await call(`/v1/admin/releases/${encoded}/promote`, {
      method: "POST",
      headers: { ...ADMIN, "content-type": "application/json" },
      body: JSON.stringify({ rollout: 100 }),
    })
    expect((await call("/v1/tauri/darwin/aarch64/0.1.0")).status).toBe(200)
    await call(`/v1/admin/releases/${encoded}/abort`, { method: "POST", headers: ADMIN })
    expect((await call("/v1/tauri/darwin/aarch64/0.1.0")).status).toBe(204)
  })

  it("does not cross platforms", async () => {
    const id = await stageDesktop("0.2.0")
    await call(`/v1/admin/releases/${encodeURIComponent(id)}/promote`, {
      method: "POST",
      headers: { ...ADMIN, "content-type": "application/json" },
      body: JSON.stringify({ rollout: 100 }),
    })
    expect((await call("/v1/tauri/windows/x86_64/0.1.0")).status).toBe(204)
  })
})

describe("admin surface", () => {
  it("refuses an unauthenticated write", async () => {
    const res = await call("/v1/admin/releases", { method: "POST", body: "{}" })
    expect(res.status).toBe(401)
  })

  it("refuses a desktop release with no package", async () => {
    const res = await call("/v1/admin/releases", {
      method: "POST",
      headers: { ...ADMIN, "content-type": "application/json" },
      body: JSON.stringify({
        assetId: "app",
        kind: "desktop",
        channel: "stable",
        version: "1.0.0",
      }),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe("incomplete_release")
  })

  it("walks the rollout ladder and refuses a step backwards", async () => {
    const id = await stageDesktop("0.2.0")
    const encoded = encodeURIComponent(id)
    for (const rollout of ROLLOUT_STEPS.slice(1)) {
      const res = await call(`/v1/admin/releases/${encoded}/promote`, {
        method: "POST",
        headers: { ...ADMIN, "content-type": "application/json" },
        body: JSON.stringify({ rollout }),
      })
      expect(res.status).toBe(200)
    }
    const back = await call(`/v1/admin/releases/${encoded}/promote`, {
      method: "POST",
      headers: { ...ADMIN, "content-type": "application/json" },
      body: JSON.stringify({ rollout: 10 }),
    })
    expect(back.status).toBe(409)
  })

  it("refuses to promote a revoked release", async () => {
    const id = await stageDesktop("0.2.0")
    const encoded = encodeURIComponent(id)
    await call(`/v1/admin/releases/${encoded}/revoke`, { method: "POST", headers: ADMIN })
    const res = await call(`/v1/admin/releases/${encoded}/promote`, {
      method: "POST",
      headers: { ...ADMIN, "content-type": "application/json" },
      body: JSON.stringify({ rollout: 100 }),
    })
    expect(res.status).toBe(409)
  })

  it("records every operator transition", async () => {
    const id = await stageDesktop("0.2.0")
    const encoded = encodeURIComponent(id)
    await call(`/v1/admin/releases/${encoded}/pause`, { method: "POST", headers: ADMIN })
    const { results } = await db()
      .prepare("SELECT action FROM release_events WHERE release_id = ?1 ORDER BY id")
      .bind(id)
      .all<{ action: string }>()
    expect((results ?? []).map((r: { action: string }) => r.action)).toEqual(["stage", "pause"])
  })
})

describe("GET /v1/catalog", () => {
  const bundle = (version: number) => ({
    root: { signed: { _type: "root", version: 1 }, signatures: [] },
    timestamp: { signed: { _type: "timestamp", version }, signatures: [] },
    snapshot: { signed: { _type: "snapshot", version }, signatures: [] },
    targets: { signed: { _type: "targets", version, entries: [] }, signatures: [] },
  })

  const publish = (version: number, channel = "stable") =>
    call("/v1/admin/catalog", {
      method: "POST",
      headers: { ...ADMIN, "content-type": "application/json" },
      body: JSON.stringify({ channel, bundle: bundle(version) }),
    })

  it("answers 204 before anything is published", async () => {
    expect((await call("/v1/catalog?channel=stable")).status).toBe(204)
  })

  it("serves the stored bundle verbatim", async () => {
    await publish(4)
    const res = await call("/v1/catalog?channel=stable")
    expect(res.status).toBe(200)
    const body = (await res.json()) as ReturnType<typeof bundle>
    expect(body.targets.signed.version).toBe(4)
  })

  it("refuses a replayed bundle version", async () => {
    await publish(4)
    const res = await publish(3)
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toBe("rollback")
  })

  it("keeps channels apart", async () => {
    await publish(4, "beta")
    expect((await call("/v1/catalog?channel=stable")).status).toBe(204)
    expect((await call("/v1/catalog?channel=beta")).status).toBe(200)
  })

  it("rejects an unknown channel rather than defaulting", async () => {
    expect((await call("/v1/catalog?channel=nightly")).status).toBe(400)
  })
})
