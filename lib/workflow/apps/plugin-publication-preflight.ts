import { APP_VERSION } from "@/lib/app-version"
import type { PluginRow } from "@/lib/db/plugin-types"
import { listPlugins } from "@/lib/db/plugins"
import { capabilitiesForPlatform, type CapabilityId } from "@/lib/platform/capabilities"
import { evaluatePluginCompatibility } from "@/lib/plugin/core/compatibility"
import { resolveLoadOrder } from "@/lib/plugin/core/load-order"
import { collectPluginRuntimeProfileDiagnostics } from "@/lib/plugin/core/runtime-compatibility"
import { validatePluginManifest } from "@/lib/plugin/core/validation"
import { getPluginSignatureVerifier } from "@/lib/plugin/security/signature"
import { preflightCapabilities } from "@/lib/workflow/runtime/capability-preflight"
import { workflowVersionDigest } from "@/lib/workflow/versioning/version-snapshot"
import type { PluginManifest, PluginStatus } from "@/types/plugin"
import type { WorkflowPluginDependencyBinding, WorkflowVersion } from "@/types/workflow/deployment"
import { WORKFLOW_NODE_KINDS } from "@/types/workflow/visual"

const BUILTIN_NODE_KINDS = new Set<string>(WORKFLOW_NODE_KINDS)
const ACTIVE_PLUGIN_STATUSES = new Set<PluginStatus>(["enabled", "suspended"])

export class WorkflowPluginPreflightError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly pluginId?: string
  ) {
    super(message)
    this.name = "WorkflowPluginPreflightError"
  }
}

export interface WorkflowPluginPreflightOptions {
  plugins?: readonly PluginRow[]
  verifySignature?: (plugin: PluginRow) => Promise<boolean>
  runtime?: { cogniaVersion: string; nodeVersion?: string; pythonVersion?: string }
}

interface PluginReference {
  pluginId: string
  capability: "tools" | "workflow" | "workflow-trigger"
  nodeId: string
  contributionKind?: string
  contributionTypeVersion?: number
  toolName?: string
}

function asManifest(row: PluginRow): PluginManifest {
  const validation = validatePluginManifest(row.manifest, { governanceMode: "block" })
  if (!validation.valid) {
    throw new WorkflowPluginPreflightError(
      "plugin-manifest-invalid",
      `Plugin ${row.id} has an invalid governed manifest: ${validation.errors.join("; ")}`,
      row.id
    )
  }
  const manifest = row.manifest as unknown as PluginManifest
  if (manifest.id !== row.id || manifest.version !== row.version) {
    throw new WorkflowPluginPreflightError(
      "plugin-identity-mismatch",
      `Plugin ${row.id} database identity does not match its manifest identity.`,
      row.id
    )
  }
  return manifest
}

function pluginStatus(row: PluginRow): PluginStatus {
  return ACTIVE_PLUGIN_STATUSES.has(row.status as PluginStatus)
    ? (row.status as PluginStatus)
    : "error"
}

function qualifiedContributionKind(pluginId: string, rawKind: string): string {
  return `${pluginId}.${rawKind}`
}

function collectDirectReferences(
  version: WorkflowVersion,
  manifests: ReadonlyMap<string, PluginManifest>
): PluginReference[] {
  const references: PluginReference[] = []
  const customContributions = new Map<string, PluginReference>()
  for (const [pluginId, manifest] of manifests) {
    for (const node of manifest.workflows?.nodes ?? []) {
      customContributions.set(qualifiedContributionKind(pluginId, node.kind), {
        pluginId,
        capability: "workflow",
        nodeId: "",
        contributionKind: node.kind,
        contributionTypeVersion: node.typeVersion,
      })
    }
    for (const trigger of manifest.workflows?.triggers ?? []) {
      customContributions.set(qualifiedContributionKind(pluginId, trigger.kind), {
        pluginId,
        capability: "workflow-trigger",
        nodeId: "",
        contributionKind: trigger.kind,
        contributionTypeVersion: trigger.typeVersion,
      })
    }
  }

  for (const node of version.definition.nodes) {
    if (node.type === "action.plugin.invoke") {
      const params = node.data.params as {
        pluginId?: unknown
        mode?: unknown
        toolName?: unknown
      }
      const pluginId = typeof params.pluginId === "string" ? params.pluginId.trim() : ""
      if (!pluginId) {
        throw new WorkflowPluginPreflightError(
          "plugin-reference-invalid",
          `Workflow node ${node.id} does not select a plugin.`
        )
      }
      const toolName = typeof params.toolName === "string" ? params.toolName.trim() : ""
      const toolMode = params.mode === "tool" || (params.mode === undefined && Boolean(toolName))
      references.push({
        pluginId,
        capability: toolMode ? "tools" : "workflow",
        nodeId: node.id,
        ...(toolMode && toolName ? { toolName } : {}),
      })
      continue
    }
    if (BUILTIN_NODE_KINDS.has(node.type)) continue
    const contribution = customContributions.get(node.type)
    if (!contribution) {
      throw new WorkflowPluginPreflightError(
        "plugin-contribution-unresolved",
        `Workflow node ${node.id} uses unresolved plugin contribution ${node.type}.`
      )
    }
    if (contribution.contributionTypeVersion !== node.typeVersion) {
      throw new WorkflowPluginPreflightError(
        "plugin-contribution-version-mismatch",
        `Workflow node ${node.id} requires ${node.type}@${node.typeVersion}, but plugin ${contribution.pluginId} declares type version ${contribution.contributionTypeVersion}.`,
        contribution.pluginId
      )
    }
    references.push({ ...contribution, nodeId: node.id })
  }
  return references
}

function dependencyClosure(
  directPluginIds: readonly string[],
  manifests: ReadonlyMap<string, PluginManifest>
): Set<string> {
  const closure = new Set<string>()
  const pending = [...directPluginIds]
  while (pending.length > 0) {
    const pluginId = pending.pop()!
    if (closure.has(pluginId)) continue
    closure.add(pluginId)
    const manifest = manifests.get(pluginId)
    if (!manifest) continue
    pending.push(...Object.keys(manifest.dependencies ?? {}))
  }
  return closure
}

async function verifyInstalledPluginSignature(plugin: PluginRow): Promise<boolean> {
  if (plugin.source === "builtin") return true
  const verifier = getPluginSignatureVerifier()
  const policy = verifier.getConfig()
  if (!policy.requireSignatures && policy.allowUntrusted) return true
  try {
    return (await verifier.verify(plugin.path)).valid
  } catch {
    return false
  }
}

/**
 * Fail closed before a public release is written, then return the exact plugin
 * artifacts that must be frozen into its dependency lock.
 */
export async function assertWorkflowPluginPublicationPreflight(
  version: WorkflowVersion,
  options: WorkflowPluginPreflightOptions = {}
): Promise<Record<string, WorkflowPluginDependencyBinding>> {
  const rows = [...(options.plugins ?? (await listPlugins()))]
  const byId = new Map(rows.map((row) => [row.id, row]))
  // Raw manifests are sufficient to identify which installed plugin owns a
  // namespaced node. Governed validation is deliberately limited to the
  // dependency closure so an unrelated disabled/broken plugin cannot block a
  // workflow release that does not use it.
  const manifests = new Map(rows.map((row) => [row.id, row.manifest as unknown as PluginManifest]))

  const references = collectDirectReferences(version, manifests)
  const closure = dependencyClosure(
    references.map((reference) => reference.pluginId),
    manifests
  )
  if (closure.size === 0) {
    const failures = preflightCapabilities(version.definition, capabilitiesForPlatform("headless"))
    if (failures.length > 0) {
      throw new WorkflowPluginPreflightError(
        "headless-capability-missing",
        `Workflow cannot run on Headless: ${failures
          .map((failure) => `${failure.nodeId} (${failure.missing.join(", ")})`)
          .join("; ")}`
      )
    }
    return {}
  }

  for (const pluginId of closure) {
    const row = byId.get(pluginId)
    if (!row) {
      throw new WorkflowPluginPreflightError(
        "plugin-missing",
        `Required plugin ${pluginId} is not installed.`,
        pluginId
      )
    }
    manifests.set(pluginId, asManifest(row))
  }

  const selectedRows = [...closure].map((pluginId) => byId.get(pluginId)!)
  const loadOrder = resolveLoadOrder(
    selectedRows.map((row) => ({
      id: row.id,
      version: row.version,
      dependencies: manifests.get(row.id)!.dependencies,
      status: pluginStatus(row),
    }))
  )
  for (const pluginId of closure) {
    const blocked = loadOrder.blocked.get(pluginId)
    if (blocked || !loadOrder.order.includes(pluginId)) {
      throw new WorkflowPluginPreflightError(
        "plugin-dependency-unavailable",
        `Plugin ${pluginId} cannot be activated with its required dependencies${blocked ? `: ${JSON.stringify(blocked)}` : "."}`,
        pluginId
      )
    }
  }

  for (const reference of references) {
    const manifest = manifests.get(reference.pluginId)!
    if (!manifest.capabilities.includes(reference.capability)) {
      throw new WorkflowPluginPreflightError(
        "plugin-capability-undeclared",
        `Plugin ${reference.pluginId} does not declare ${reference.capability} for workflow node ${reference.nodeId}.`,
        reference.pluginId
      )
    }
    if (reference.toolName && !manifest.tools?.some((tool) => tool.name === reference.toolName)) {
      throw new WorkflowPluginPreflightError(
        "plugin-tool-unresolved",
        `Plugin ${reference.pluginId} does not declare tool ${reference.toolName}.`,
        reference.pluginId
      )
    }
  }

  const runtime = options.runtime ?? {
    cogniaVersion: APP_VERSION,
    nodeVersion: "26.0.0",
    pythonVersion: "3.11.0",
  }
  const verifySignature = options.verifySignature ?? verifyInstalledPluginSignature
  const lock: Record<string, WorkflowPluginDependencyBinding> = {}
  for (const pluginId of loadOrder.order) {
    const row = byId.get(pluginId)!
    const manifest = manifests.get(pluginId)!
    if (!row.enabled && row.lifecycle?.intent !== "enabled") {
      throw new WorkflowPluginPreflightError(
        "plugin-disabled",
        `Plugin ${pluginId} is not enabled for production execution.`,
        pluginId
      )
    }
    if (!(await verifySignature(row))) {
      throw new WorkflowPluginPreflightError(
        "plugin-untrusted",
        `Plugin ${pluginId} did not pass signature trust verification.`,
        pluginId
      )
    }
    const compatibility = evaluatePluginCompatibility(manifest, runtime)
    const runtimeDiagnostics = collectPluginRuntimeProfileDiagnostics(manifest, "headless")
    const blockingDiagnostics = [
      ...compatibility.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
      ...runtimeDiagnostics,
    ]
    if (blockingDiagnostics.length > 0) {
      throw new WorkflowPluginPreflightError(
        "plugin-runtime-incompatible",
        `Plugin ${pluginId} failed Headless runtime preflight: ${blockingDiagnostics
          .map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`)
          .join("; ")}`,
        pluginId
      )
    }
    lock[pluginId] = {
      pluginId,
      version: row.version,
      manifestDigest: workflowVersionDigest(manifest),
      capabilities: [...manifest.capabilities].sort(),
      runtimeProfile: "headless",
    }
  }

  const headlessCapabilities: CapabilityId[] = [
    ...capabilitiesForPlatform("headless"),
    ...Object.keys(lock).map((pluginId) => `plugin:${pluginId}` as const),
  ]
  const failures = preflightCapabilities(version.definition, headlessCapabilities)
  if (failures.length > 0) {
    throw new WorkflowPluginPreflightError(
      "headless-capability-missing",
      `Workflow cannot run on Headless: ${failures
        .map((failure) => `${failure.nodeId} (${failure.missing.join(", ")})`)
        .join("; ")}`
    )
  }
  return lock
}
