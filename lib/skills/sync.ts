// Bidirectional sync between Dexie skills and ~/.claude/skills/<dir>/. The
// frontend is the SoT, but the on-disk view is what other Claude tooling
// reads, so users can opt in to "push to disk" or "pull from disk" via the
// toolbar Sync button.
//
// Identity: skills are matched by `nativeDirectory` first, then by name slug.
// We never delete on-disk skills the user didn't originate from the app —
// only ones whose `nativeDirectory` we recorded.

import {
  skillsCatalogGet,
  skillsInstallMirrored,
  skillsInstallNative,
  skillsScanNative,
  type InstallSkillMirroredRequest,
  type InstallSkillMirroredResponse,
  type NativeSkill,
  type NativeSkillResource,
  type SkillBundleUploadHandle,
  type SkillsTarget,
} from "@/lib/claude/ipc"
import {
  bulkImportSkills,
  getSkill,
  listSkills,
  persistSkillBundle,
  updateSkill,
} from "@/lib/db/skills"
import { listResourcesForSkill, type SkillResourceDraft } from "@/lib/db/skill-resources"
import { parseSkillMarkdown, serializeSkill, skillFilename } from "@/lib/claude/skills-io"
import { isTauri } from "@/lib/tauri"
import { getActiveRemoteTransport } from "@/lib/tauri/transport-routing"
import type { Transport } from "@/lib/tauri/transport-types"
import {
  activeHostSupportsFeature,
  useRemoteHostStore,
} from "@/stores/remote-host/remote-host-store"
import { resolveSkillBundleMirrors, useSettingsStore } from "@/stores/settings/settings-store"
import type { Skill, SkillResource } from "@cognia/agent-config-types"
import { hasNoLeakingPiiDeep } from "@cognia/redact"
import { deriveSkillSlug } from "./slug"

export interface SyncResult {
  pushed: number
  pulled: number
  skipped: number
  errors: { name: string; error: string }[]
}

const TIMESTAMP_FUDGE_MS = 1000

function hasActiveRemoteHost(): boolean {
  return useRemoteHostStore.getState().activeHostId !== null
}

export function canReadHostSkills(): boolean {
  if (hasActiveRemoteHost()) {
    return activeHostSupportsFeature("skills.catalog", "skills_catalog_get")
  }
  return isTauri()
}

export function canWriteHostSkills(): boolean {
  if (hasActiveRemoteHost()) {
    return [
      "skills_bundle_upload_open",
      "skills_bundle_upload_write",
      "skills_bundle_upload_commit",
      "skills_bundle_upload_abort",
      "skills_install_atomic",
    ].every((operation) => activeHostSupportsFeature("skills.atomic-install", operation))
  }
  return isTauri()
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes))
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

async function installRemoteAtomic(
  request: InstallSkillMirroredRequest,
  target: RemoteSkillTarget
): Promise<InstallSkillMirroredResponse> {
  const bytes = new TextEncoder().encode(JSON.stringify(request))
  const lease = await remoteSkillCall<{ token: string }>(target, "host_admin_lease_issue", {
    operations: [
      "skills_bundle_upload_open",
      "skills_bundle_upload_write",
      "skills_bundle_upload_commit",
      "skills_bundle_upload_abort",
      "skills_install_atomic",
    ],
    ttlSeconds: 10 * 60,
    confirmed: true,
  })
  const handle = await remoteSkillCall<SkillBundleUploadHandle>(
    target,
    "skills_bundle_upload_open",
    {
      request: {
        expectedSize: bytes.byteLength,
        expectedHash: await sha256Hex(bytes),
      },
      adminLease: lease.token,
    }
  )
  try {
    let offset = 0
    while (offset < bytes.byteLength) {
      const chunk = bytes.subarray(offset, offset + handle.chunkBytes)
      offset = await remoteSkillCall<number>(target, "skills_bundle_upload_write", {
        handleId: handle.handleId,
        offset,
        dataBase64: bytesToBase64(chunk),
        chunkHash: await sha256Hex(chunk),
        adminLease: lease.token,
      })
    }
    await remoteSkillCall<void>(target, "skills_bundle_upload_commit", {
      handleId: handle.handleId,
      adminLease: lease.token,
    })
    return await remoteSkillCall<InstallSkillMirroredResponse>(target, "skills_install_atomic", {
      handleId: handle.handleId,
      adminLease: lease.token,
    })
  } catch (error) {
    await target.transport
      .call<void>("skills_bundle_upload_abort", {
        handleId: handle.handleId,
        adminLease: lease.token,
      })
      .catch(() => undefined)
    throw error
  }
}

interface RemoteSkillTarget {
  hostId: string
  transport: Transport
}

function captureRemoteSkillTarget(expectedHostId?: string): RemoteSkillTarget | null {
  const hostId = useRemoteHostStore.getState().activeHostId
  if (!hostId) return null
  if (expectedHostId && hostId !== expectedHostId) {
    throw new Error("REMOTE_RESPONSE_STALE: active host changed during Skill sync")
  }
  const remoteTransport = getActiveRemoteTransport()
  if (!remoteTransport) {
    throw new Error("REMOTE_PROXY_DISCONNECTED: active host transport is unavailable")
  }
  return { hostId, transport: remoteTransport }
}

function assertRemoteSkillTarget(target: RemoteSkillTarget): void {
  const state = useRemoteHostStore.getState()
  if (state.activeHostId !== target.hostId || getActiveRemoteTransport() !== target.transport) {
    throw new Error("REMOTE_RESPONSE_STALE: active host changed during Skill sync")
  }
}

async function remoteSkillCall<T>(
  target: RemoteSkillTarget,
  name: string,
  args: Record<string, unknown>
): Promise<T> {
  assertRemoteSkillTarget(target)
  const result = await target.transport.call<T>(name, args)
  assertRemoteSkillTarget(target)
  return result
}

/**
 * Hash skill + resources. Used for `syncFingerprint`. Web-mode runs use
 * `crypto.subtle`; if unavailable we fall back to a stringified hash so
 * the function is callable in tests too.
 *
 * Exported so the bundle loader and the upsert helper compute the same
 * value off the same canonical representation — re-imports that produce
 * a matching fingerprint can short-circuit before any disk write.
 */
export async function fingerprint(skill: Skill, resources: SkillResource[]): Promise<string> {
  const md = serializeSkill(skill)
  const stable = JSON.stringify({
    md,
    codexOpenAiYaml: skill.codexOpenAiYaml,
    res: resources
      .map((r) => ({
        path: r.path,
        kind: r.kind,
        size: r.size,
        encoding: r.encoding,
        content: r.content,
      }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  })
  if (typeof crypto !== "undefined" && crypto.subtle && typeof TextEncoder !== "undefined") {
    const buf = new TextEncoder().encode(stable)
    const digest = await crypto.subtle.digest("SHA-256", buf)
    const bytes = new Uint8Array(digest)
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  }
  // Fallback: simple non-cryptographic hash.
  let h = 0
  for (let i = 0; i < stable.length; i++) {
    h = ((h << 5) - h + stable.charCodeAt(i)) | 0
  }
  return `${(h >>> 0).toString(16)}-${stable.length}`
}

function toNativeResources(resources: SkillResource[]): NativeSkillResource[] {
  return resources.map((r) => ({
    kind: r.kind,
    path: r.path,
    name: r.name,
    content: r.content,
    encoding: r.encoding ?? "utf-8",
    mimeType: r.mimeType,
    size: r.size ?? 0,
  }))
}

function fromNativeResources(
  resources: NativeSkillResource[],
  skillId: string
): SkillResourceDraft[] {
  return resources.map((r) => ({
    skillId,
    kind: r.kind,
    name: r.name,
    path: r.path,
    content: r.content,
    encoding: r.encoding,
    mimeType: r.mimeType,
    size: r.size,
  }))
}

/**
 * Resolve the active set of mirror targets for the push pipeline. Cognia
 * is always on; Claude / Codex respect the per-user toggle in
 * `AppSettings.skillBundleMirrors` (defaults `{ claude: true, codex: true }`).
 * Exposed as a tiny helper so the test suite can stub the settings read.
 */
export function activeMirrorTargets(): SkillsTarget[] {
  const settings = useSettingsStore.getState().settings
  const flags = resolveSkillBundleMirrors(settings)
  const targets: SkillsTarget[] = ["cognia"]
  if (flags.claude) targets.push("claude")
  if (flags.codex) targets.push("codex")
  return targets
}

/**
 * Push a single skill to its enabled mirrors. Cognia is always written;
 * Claude / Codex respect `AppSettings.skillBundleMirrors`. Mirrors the
 * legacy single-target shape so callers (per-card UI button + the batch
 * caller) compose results identically.
 *
 * Built-ins are skipped (returns skipped=1). Web-mode returns an "(env)" error.
 *
 * Fingerprint precheck: when the row's current `syncFingerprint` matches
 * a freshly-computed value, we skip the disk write entirely — re-pushing
 * an unchanged skill is a no-op and counts as `skipped`. This is the
 * idempotency hook the bundle dialog relies on for "re-import same zip ⇒
 * nothing happens" semantics.
 */
export async function pushOneToNative(
  skillId: string,
  expectedRemoteHostId?: string
): Promise<SyncResult> {
  const result: SyncResult = { pushed: 0, pulled: 0, skipped: 0, errors: [] }
  if (!canWriteHostSkills()) {
    return {
      ...result,
      errors: [{ name: "(env)", error: "The active host does not support atomic Skill writes." }],
    }
  }
  const remoteTarget = captureRemoteSkillTarget(expectedRemoteHostId)
  const skill = await getSkill(skillId)
  if (!skill) {
    return { ...result, errors: [{ name: skillId, error: "Skill not found." }] }
  }
  if (skill.isBuiltIn || (skill.source ?? "custom") === "builtin") {
    return { ...result, skipped: 1 }
  }
  try {
    const resources = await listResourcesForSkill(skill.id)
    const fp = await fingerprint(skill, resources)
    // Re-pushing an unchanged skill is a no-op. The disk-side fingerprint
    // assumption is "if our recorded value matches and the canonical
    // directory we'd write to is recorded on the row, nothing's drifted".
    // This shortcuts the cost of a clean+write on every "Sync now" click.
    if (!remoteTarget && skill.syncFingerprint === fp && skill.nativeDirectory) {
      return { ...result, skipped: 1 }
    }
    const dirName = deriveSkillSlug(skill)
    const request: InstallSkillMirroredRequest = {
      dirName,
      content: serializeSkill(skill),
      resources: [
        ...toNativeResources(resources),
        ...(skill.codexOpenAiYaml !== undefined
          ? [
              {
                kind: "asset" as const,
                path: "agents/openai.yaml",
                name: "openai.yaml",
                content: skill.codexOpenAiYaml,
                encoding: "utf-8" as const,
                mimeType: "application/yaml",
                size: new Blob([skill.codexOpenAiYaml]).size,
              },
            ]
          : []),
      ],
      clean: true,
      targets: activeMirrorTargets(),
      trashBeforeClean: !!skill.syncFingerprint && skill.syncFingerprint !== fp,
    }
    if (
      remoteTarget &&
      !hasNoLeakingPiiDeep({ content: request.content, resources: request.resources })
    ) {
      throw new Error("remote Skill install rejected by the renderer PII gate")
    }
    const response = remoteTarget
      ? await installRemoteAtomic(request, remoteTarget)
      : await skillsInstallMirrored(request)
    // Prefer the cognia outcome as the row's `nativeDirectory`: the
    // cognia copy is canonical, the others are throwaway projections.
    const cognia = response.targets.find((t) => t.target === "cognia")
    const directory = cognia?.directory ?? response.targets[0]?.directory ?? ""
    await updateSkill(skill.id, {
      nativeDirectory: directory,
      syncOrigin: "frontend",
      syncFingerprint: fp,
      lastSyncedAt: Date.now(),
      lastSyncError: null,
    })
    return { ...result, pushed: 1 }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await updateSkill(skill.id, {
      lastSyncError: message,
      lastSyncedAt: Date.now(),
    })
    return { ...result, errors: [{ name: skill.name, error: message }] }
  }
}

// Keep the legacy single-target writer reachable for backward-compat with
// any caller that hasn't migrated to the mirrored path. Currently unused
// internally; exported via re-export below.
void skillsInstallNative

/**
 * Push every Dexie skill (excluding built-ins) to ~/.claude/skills/. Updates
 * each row's `nativeDirectory`, `syncFingerprint`, `lastSyncedAt`. Built-ins
 * are skipped because they're not user-edited content.
 */
export async function pushAllToNative(): Promise<SyncResult> {
  const result: SyncResult = { pushed: 0, pulled: 0, skipped: 0, errors: [] }
  if (!canWriteHostSkills()) {
    return {
      ...result,
      errors: [{ name: "(env)", error: "The active host does not support atomic Skill writes." }],
    }
  }
  const remoteHostId = useRemoteHostStore.getState().activeHostId ?? undefined
  const all = await listSkills()
  for (const skill of all) {
    const one = await pushOneToNative(skill.id, remoteHostId)
    result.pushed += one.pushed
    result.skipped += one.skipped
    result.errors.push(...one.errors)
  }
  return result
}

/**
 * Pull every skill from ~/.claude/skills/, importing or updating Dexie
 * rows. Each on-disk skill is matched by `nativeDirectory` first, then by
 * name. Existing rows that are newer than the on-disk file are left alone.
 */
export async function pullAllFromNative(): Promise<SyncResult> {
  const result: SyncResult = { pushed: 0, pulled: 0, skipped: 0, errors: [] }
  if (!canReadHostSkills()) {
    return {
      ...result,
      errors: [{ name: "(env)", error: "The active host does not expose its Skills catalog." }],
    }
  }
  const native: NativeSkill[] = hasActiveRemoteHost()
    ? await skillsCatalogGet().then((catalog) =>
        catalog.cognia.length > 0 ? catalog.cognia : catalog.claude
      )
    : await skillsScanNative()
  if (native.length === 0) return result

  const local = await listSkills()
  const byDir = new Map<string, Skill>()
  const byName = new Map<string, Skill>()
  for (const s of local) {
    if (s.nativeDirectory) byDir.set(s.nativeDirectory, s)
    byName.set(s.name.toLowerCase(), s)
  }

  for (const skill of native) {
    try {
      const { draft } = parseSkillMarkdown(skill.content, {
        fallbackName: skill.dirName,
      })
      const codexYaml = skill.resources.find((resource) =>
        /(^|\/)agents\/openai\.ya?ml$/i.test(resource.path.replace(/\\/g, "/"))
      )
      if (codexYaml?.encoding === "utf-8") draft.codexOpenAiYaml = codexYaml.content
      const bundledResources = skill.resources.filter((resource) => resource !== codexYaml)
      const drafts = [
        {
          ...draft,
          source: "imported" as const,
          syncOrigin: "native" as const,
          nativeDirectory: skill.filePath.replace(/SKILL\.md$/i, "").replace(/[\\/]+$/, ""),
        },
      ]
      const matchByDir = byDir.get(drafts[0].nativeDirectory!)
      const matchByName = byName.get(drafts[0].name.toLowerCase())
      const existing = matchByDir ?? matchByName

      if (existing) {
        // Native wins when the on-disk SKILL.md was modified after our last
        // recorded sync. `mtimeMs === 0` means the filesystem didn't expose
        // mtime — fall back to fingerprint comparison to decide. When the
        // user has edited the Dexie row after the last sync, we keep ours.
        const nativeMtime = skill.mtimeMs || 0
        const lastSynced = existing.lastSyncedAt ?? 0
        const localChangedSinceSync = (existing.updatedAt ?? 0) > lastSynced + TIMESTAMP_FUDGE_MS
        const nativeNewer = nativeMtime > 0 ? nativeMtime > lastSynced + TIMESTAMP_FUDGE_MS : true
        if (!nativeNewer || localChangedSinceSync) {
          result.skipped += 1
          continue
        }
        // Second gate: recompute fingerprint after a candidate-update build
        // and skip if it matches what we already stored. Avoids needless
        // Dexie writes when only mtime changed (e.g., touch).
        const candidateResources = fromNativeResources(bundledResources, existing.id)
        const fpInput: Skill = {
          ...existing,
          slug: drafts[0].slug ?? existing.slug,
          name: drafts[0].name,
          description: drafts[0].description,
          compatibility: drafts[0].compatibility,
          metadata: drafts[0].metadata,
          invocationPolicy: drafts[0].invocationPolicy,
          frontmatterExtensions: drafts[0].frontmatterExtensions,
          codexOpenAiYaml: drafts[0].codexOpenAiYaml,
          content: drafts[0].content,
          allowedTools: drafts[0].allowedTools,
          tags: drafts[0].tags,
          category: drafts[0].category ?? existing.category,
          version: drafts[0].version,
          author: drafts[0].author,
          license: drafts[0].license,
        }
        const candidateFp = await fingerprint(
          fpInput,
          candidateResources.map((r, i) => ({
            id: `tmp-${i}`,
            skillId: existing.id,
            kind: r.kind,
            name: r.name,
            path: r.path,
            content: r.content,
            encoding: r.encoding ?? "utf-8",
            mimeType: r.mimeType,
            size: r.size ?? 0,
            createdAt: 0,
            updatedAt: 0,
          }))
        )
        if (existing.syncFingerprint && existing.syncFingerprint === candidateFp) {
          // Bump the lastSyncedAt timestamp so future pulls don't re-evaluate
          // the same file every run, but skip the row + resource churn.
          await updateSkill(existing.id, { lastSyncedAt: Date.now(), lastSyncError: null })
          result.skipped += 1
          continue
        }
        await persistSkillBundle({
          skill: {
            ...existing,
            slug: drafts[0].slug ?? existing.slug,
            name: drafts[0].name,
            description: drafts[0].description,
            compatibility: drafts[0].compatibility,
            metadata: drafts[0].metadata,
            invocationPolicy: drafts[0].invocationPolicy,
            frontmatterExtensions: drafts[0].frontmatterExtensions,
            codexOpenAiYaml: drafts[0].codexOpenAiYaml,
            content: drafts[0].content,
            allowedTools: drafts[0].allowedTools,
            tags: drafts[0].tags,
            category: drafts[0].category,
            version: drafts[0].version,
            author: drafts[0].author,
            license: drafts[0].license,
            source: "imported",
            syncOrigin: "native",
            nativeDirectory: drafts[0].nativeDirectory,
            syncFingerprint: candidateFp,
            lastSyncedAt: Date.now(),
            lastSyncError: null,
            updatedAt: Date.now(),
          },
          resources: candidateResources,
        })
      } else {
        const report = await bulkImportSkills(
          [{ ...drafts[0], resources: fromNativeResources(bundledResources, "") }],
          "skip"
        )
        if (report.created > 0) {
          // Look up the freshly-created row to attach resources.
          const refreshed = await listSkills()
          const created = refreshed.find(
            (r) => r.name.toLowerCase() === drafts[0].name.toLowerCase()
          )
          if (created) {
            const drafts2 = fromNativeResources(bundledResources, created.id)
            // Compute the fingerprint from the drafts directly — the
            // The atomic importer already stored these rows; we don't need
            // to read them back (the fields contributing to
            // the fingerprint are identical between draft and stored
            // shape). This keeps the post-import update independent of
            // whatever shape the replacer returns in tests.
            const fpResources: SkillResource[] = drafts2.map((d, i) => ({
              id: `tmp-${i}`,
              skillId: created.id,
              kind: d.kind,
              name: d.name,
              path: d.path,
              content: d.content,
              encoding: d.encoding ?? "utf-8",
              mimeType: d.mimeType,
              size: d.size ?? 0,
              createdAt: 0,
              updatedAt: 0,
            }))
            const fp = await fingerprint(created, fpResources)
            await updateSkill(created.id, {
              syncFingerprint: fp,
              lastSyncedAt: Date.now(),
              lastSyncError: null,
            })
          }
        }
      }
      result.pulled += 1
    } catch (err) {
      result.errors.push({
        name: skill.dirName,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return result
}

/** Suggested filename for a skill — used by the on-disk file listing. */
export function suggestedFilename(skill: Skill): string {
  return skillFilename(skill.name)
}
