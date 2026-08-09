// Certification bundle store (ADR-0090 Phase 5).
//
// Authority = signed manifest FILES under
//   <dataDir>/agent-certification/bundles/<bundleId>/manifest.json
// with a CAS-written `active-bundle.json` pointer and an UNSIGNED
// `health.json` overlay (per-capability circuit state — down-rank input
// only, never up-rank). Desktop and headless share the layout; Dexie holds
// only a rebuildable projection.
//
// The filesystem is injected so the same port serves the Tauri fs surface,
// plain node fs (headless), and tests.

import type { CompatibilityManifest } from "@cognia/agent-config-types/compatibility-manifest"
import type { AgentCapabilityId } from "@cognia/agent-config-types/agent-execution"
import {
  manifestSigningPayload,
  validateCompatibilityManifest,
} from "@cognia/agent-config-types/compatibility-manifest"
import type { CurrentVersions } from "./staleness"
import { evaluateCompatibilityGate } from "./compatibility-gate"
import { recordCapabilityFailure, recordCapabilitySuccess } from "./capability-health"

export interface CertificationFs {
  readFile(path: string): Promise<string | null>
  writeFile(path: string, content: string): Promise<void>
  listDir(path: string): Promise<string[]>
}

export interface ActiveBundlePointer {
  bundleId: string
  activatedAt: string
  previousBundleId?: string
}

export interface CapabilityHealthEntry {
  keyId: string
  capability: string
  consecutiveFailures: number
  /** ISO time until which the capability circuit is open. */
  openUntil?: string
}

/**
 * Cognia release verification key (Ed25519, SPKI/PEM). Verify-only — the
 * signing half lives exclusively in CI secrets (emit-manifest). The `local`
 * issuer signs with an ad-hoc key whose public half is embedded in the
 * manifest bundle for dev round-trips; managed policy can require
 * `issuer: "cognia-ci"` and this key.
 */
export const COGNIA_RELEASE_PUBKEY_PEM = process.env.NEXT_PUBLIC_COGNIA_CERT_PUBKEY ?? ""

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
}

function decodePublicKeyPem(publicKeyPem: string): Uint8Array<ArrayBuffer> {
  const encoded = publicKeyPem
    .replace("-----BEGIN PUBLIC KEY-----", "")
    .replace("-----END PUBLIC KEY-----", "")
    .replace(/\s/g, "")
  return decodeBase64(encoded)
}

export class CertificationStore {
  constructor(
    private readonly fs: CertificationFs,
    private readonly rootDir: string
  ) {}

  private bundleDir(bundleId: string): string {
    return `${this.rootDir}/bundles/${bundleId}`
  }

  async listBundles(): Promise<string[]> {
    try {
      return (await this.fs.listDir(`${this.rootDir}/bundles`)).sort()
    } catch {
      return []
    }
  }

  async readManifest(bundleId: string): Promise<CompatibilityManifest | null> {
    const raw = await this.fs.readFile(`${this.bundleDir(bundleId)}/manifest.json`)
    if (raw === null) return null
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return null
    }
    const validated = validateCompatibilityManifest(parsed)
    return validated.ok ? validated.value : null
  }

  /**
   * Verify the manifest's Ed25519 signature against a PEM public key.
   * Unsigned manifests never verify.
   */
  async verifySignature(manifest: CompatibilityManifest, publicKeyPem: string): Promise<boolean> {
    if (!manifest.signature || !publicKeyPem) return false
    try {
      const key = await globalThis.crypto.subtle.importKey(
        "spki",
        decodePublicKeyPem(publicKeyPem),
        { name: "Ed25519" },
        false,
        ["verify"]
      )
      return globalThis.crypto.subtle.verify(
        "Ed25519",
        key,
        decodeBase64(manifest.signature),
        new TextEncoder().encode(manifestSigningPayload(manifest))
      )
    } catch {
      return false
    }
  }

  async getActiveBundle(): Promise<ActiveBundlePointer | null> {
    const raw = await this.fs.readFile(`${this.rootDir}/active-bundle.json`)
    if (raw === null) return null
    try {
      const parsed = JSON.parse(raw) as ActiveBundlePointer
      return typeof parsed.bundleId === "string" ? parsed : null
    } catch {
      return null
    }
  }

  /**
   * CAS-activate a bundle: the caller passes the pointer it READ
   * (`expected`, null for "none"); a concurrent activation in between makes
   * this throw instead of last-writer-wins.
   */
  async activateBundle(
    bundleId: string,
    expected: ActiveBundlePointer | null
  ): Promise<ActiveBundlePointer> {
    const manifest = await this.readManifest(bundleId)
    if (!manifest) throw new Error(`bundle ${bundleId} has no valid manifest`)
    const current = await this.getActiveBundle()
    if ((current?.bundleId ?? null) !== (expected?.bundleId ?? null)) {
      throw new Error(
        `activation conflict: expected active=${expected?.bundleId ?? "none"}, found ${current?.bundleId ?? "none"}`
      )
    }
    const next: ActiveBundlePointer = {
      bundleId,
      activatedAt: new Date().toISOString(),
      ...(current ? { previousBundleId: current.bundleId } : {}),
    }
    await this.fs.writeFile(`${this.rootDir}/active-bundle.json`, JSON.stringify(next, null, 2))
    return next
  }

  /** Roll back to the pointer's previousBundleId (verified first). */
  async rollback(): Promise<ActiveBundlePointer> {
    const current = await this.getActiveBundle()
    if (!current?.previousBundleId) {
      throw new Error("no previous bundle recorded — nothing to roll back to")
    }
    return this.activateBundle(current.previousBundleId, current)
  }

  // ---- Unsigned health overlay (down-rank only) ---------------------------

  async readHealth(): Promise<CapabilityHealthEntry[]> {
    const raw = await this.fs.readFile(`${this.rootDir}/health.json`)
    if (raw === null) return []
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  async writeHealth(entries: CapabilityHealthEntry[]): Promise<void> {
    await this.fs.writeFile(`${this.rootDir}/health.json`, JSON.stringify(entries, null, 2))
  }
}

export interface CertificationRuntime {
  store: CertificationStore
  publicKeyPem: string
  current: CurrentVersions
  managedPolicy?: { requireCiIssuer?: boolean }
}

export interface ActiveCertificationInput {
  runtime: string
  ingressProtocol: string
  routeMode: string
  translationMode: string
  deploymentRef: string
  model: string
  requires: AgentCapabilityId[]
  prefers: AgentCapabilityId[]
}

export type ActiveCertificationResolution =
  | {
      accepted: true
      certifiedPath: {
        recordRef: string
        evidence: "native" | "vendor-certified" | "cognia-verified"
        suiteVersion?: string
        disabledOptional: AgentCapabilityId[]
      }
    }
  | { accepted: false; reasons: string[]; blockedRequired?: AgentCapabilityId[] }

let installedRuntime: CertificationRuntime | null = null
let healthWriteQueue: Promise<void> = Promise.resolve()

/** Install the single certification authority consumed by agent execution. */
export function installCertificationRuntime(runtime: CertificationRuntime | null): void {
  installedRuntime = runtime
  healthWriteQueue = Promise.resolve()
}

/** Persist an observed command outcome into the active certification overlay. */
export async function recordCertifiedCapabilityOutcome(
  recordRef: string | undefined,
  capability: AgentCapabilityId,
  outcome: "success" | "failure"
): Promise<void> {
  const runtime = installedRuntime
  if (!runtime || !recordRef) return
  const separator = recordRef.indexOf(":")
  if (separator < 0 || separator === recordRef.length - 1) return
  const keyId = recordRef.slice(separator + 1)
  healthWriteQueue = healthWriteQueue
    .catch(() => undefined)
    .then(async () => {
      const current = await runtime.store.readHealth()
      const next =
        outcome === "failure"
          ? recordCapabilityFailure(current, keyId, capability)
          : recordCapabilitySuccess(current, keyId, capability)
      await runtime.store.writeHealth(next)
    })
  await healthWriteQueue
}

/** Resolve the active signed bundle for one exact execution path. */
export async function resolveActiveCertification(
  input: ActiveCertificationInput
): Promise<ActiveCertificationResolution | undefined> {
  const runtime = installedRuntime
  if (!runtime) return undefined
  const pointer = await runtime.store.getActiveBundle()
  if (!pointer) return undefined
  const manifest = await runtime.store.readManifest(pointer.bundleId)
  if (!manifest) return { accepted: false, reasons: ["active manifest is missing or invalid"] }

  const pathFields = [
    "runtime",
    "ingressProtocol",
    "routeMode",
    "translationMode",
    "deploymentRef",
    "model",
  ] as const
  const mismatch = pathFields.find((field) => manifest.key[field] !== input[field])
  if (mismatch) {
    return { accepted: false, reasons: [`active manifest path mismatch: ${mismatch}`] }
  }

  const signatureValid = await runtime.store.verifySignature(manifest, runtime.publicKeyPem)
  const gate = evaluateCompatibilityGate({
    manifest,
    signatureValid,
    current: runtime.current,
    requires: input.requires,
    prefers: input.prefers,
    health: await runtime.store.readHealth(),
    managedPolicy: runtime.managedPolicy,
  })
  if (!gate.accepted) {
    const capabilityReasonsOnly = gate.reasons.every((reason) =>
      reason.startsWith("required capability ")
    )
    const blockedRequired = capabilityReasonsOnly
      ? input.requires.filter((capability) =>
          gate.reasons.some((reason) => reason.startsWith(`required capability ${capability} `))
        )
      : []
    return {
      ...gate,
      ...(blockedRequired.length > 0 ? { blockedRequired } : {}),
    }
  }
  if (
    manifest.evidence !== "native" &&
    manifest.evidence !== "vendor-certified" &&
    manifest.evidence !== "cognia-verified"
  ) {
    return { accepted: false, reasons: [`unsupported evidence: ${manifest.evidence}`] }
  }
  return {
    accepted: true,
    certifiedPath: {
      recordRef: gate.recordRef,
      evidence: manifest.evidence,
      suiteVersion: manifest.key.suiteVersion,
      disabledOptional: gate.disabledOptional,
    },
  }
}

export interface DesktopCertificationRuntimeDeps {
  resolveHome?: () => Promise<string | null>
  fs?: CertificationFs
  publicKeyPem?: string
  current?: CurrentVersions
}

/** Hydrate the existing store from the shared Cognia CLI home. */
export async function installDesktopCertificationRuntime(
  deps: DesktopCertificationRuntimeDeps = {}
): Promise<CertificationStore | null> {
  const resolveHome =
    deps.resolveHome ?? (async () => (await import("@/lib/cli-bridge/home")).resolveCliHome())
  const home = await resolveHome()
  if (!home) {
    installCertificationRuntime(null)
    return null
  }
  const root = `${home.replace(/[\\/]+$/, "")}/agent-certification`
  const fs =
    deps.fs ??
    ({
      async readFile(path: string) {
        try {
          return await (await import("@/lib/file/file-operations")).readTextFile(path)
        } catch {
          return null
        }
      },
      async writeFile(path: string, content: string) {
        await (await import("@/lib/file/file-operations")).writeTextFile(path, content)
      },
      async listDir(path: string) {
        return (await import("@/lib/file/file-operations")).readDir(path)
      },
    } satisfies CertificationFs)
  const versions = await import("@cognia/agent-config-types/runtime-versions")
  const store = new CertificationStore(fs, root)
  installCertificationRuntime({
    store,
    publicKeyPem: deps.publicKeyPem ?? COGNIA_RELEASE_PUBKEY_PEM,
    current: deps.current ?? {
      agentSdkVersion: versions.PINNED_RUNTIME_VERSIONS.agentSdkVersion,
      gatewayVersion: versions.PINNED_RUNTIME_VERSIONS.gatewayCrateVersion,
      claudeCodeVersion: versions.PINNED_RUNTIME_VERSIONS.claudeCodeVersion,
      suiteVersion: versions.PINNED_RUNTIME_VERSIONS.certificationSuiteVersion,
    },
    managedPolicy: { requireCiIssuer: true },
  })
  return store
}
