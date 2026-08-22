/**
 * Typed access to `protocol/agent-capabilities.json` (ADR-0090 external SSOT).
 *
 * The JSON is the source of truth for the two STATIC merge layers — the
 * protocol's complete capability row, and the per-preset refinement of it. This
 * module is the only thing that reads it, so there is exactly one place where a
 * malformed manifest can be caught and exactly one shape the rest of the code
 * sees.
 *
 * Why a manifest at all, rather than a TS table: the same rows are consumed by
 * the renderer, the CLI, the TUI and a gate, and three of those four used to
 * carry their own private copy (`PROTOCOL_CAPABILITIES` in the CLI,
 * `externalCapabilities()` in the TUI, `RUNTIME_CAPABILITIES.external` in the
 * resolver). Four tables meant four different answers to the same question.
 *
 * Validation is eager on first read and throws. A checked-in manifest that
 * fails is a build defect, not a runtime condition to degrade around — and
 * degrading would mean silently answering "unknown" for a protocol whose row
 * exists, which is exactly the class of lie this contract removes.
 */

import MANIFEST from "@/protocol/agent-capabilities.json"
import {
  BUILTIN_EXECUTABLE_EXTERNAL_AGENT_PROTOCOLS,
  EXTERNAL_AGENT_CAPABILITY_EVIDENCE,
  EXTERNAL_AGENT_CAPABILITY_IDS,
  type BuiltinExecutableExternalAgentProtocol,
  type ExternalAgentCapabilityCell,
  type ExternalAgentCapabilityEvidence,
  type ExternalAgentCapabilityId,
  type ExternalAgentCapabilityLayerInput,
  type ExternalAgentCapabilityLevel,
  type ExternalAgentCapabilityMatrix,
} from "@cognia/agent-config-types/external-agent-capability"

/** Optional `ProtocolAdapter` methods the layer-3 refinement keys off. */
export type AdapterMethodName =
  | "steerTurn"
  | "setSessionModel"
  | "resumeSession"
  | "listSessions"
  | "setSessionMode"
  | "respondToElicitation"
  | "compactSession"

export interface ExternalCapabilityManifest {
  version: number
  description: string
  capabilityIds: readonly ExternalAgentCapabilityId[]
  adapterMethodCapabilities: Readonly<Partial<Record<ExternalAgentCapabilityId, AdapterMethodName>>>
  protocols: Readonly<
    Record<
      BuiltinExecutableExternalAgentProtocol,
      {
        label: string
        note: string
        capabilities: Record<ExternalAgentCapabilityId, ExternalAgentCapabilityCell>
      }
    >
  >
  presetRefinements: Readonly<
    Record<
      string,
      {
        protocol: BuiltinExecutableExternalAgentProtocol
        note: string
        capabilities: ExternalAgentCapabilityMatrix
      }
    >
  >
}

const LEVELS: readonly ExternalAgentCapabilityLevel[] = [
  "native",
  "equivalent",
  "unsupported",
  "unknown",
]

class ManifestError extends Error {
  constructor(message: string) {
    super(`protocol/agent-capabilities.json: ${message}`)
    this.name = "ExternalCapabilityManifestError"
  }
}

function validateCell(where: string, raw: unknown): ExternalAgentCapabilityCell {
  if (!raw || typeof raw !== "object") throw new ManifestError(`${where} is not an object`)
  const cell = raw as Record<string, unknown>
  const level = cell.level as ExternalAgentCapabilityLevel
  const evidence = cell.evidence as ExternalAgentCapabilityEvidence
  if (!LEVELS.includes(level)) throw new ManifestError(`${where}: bad level "${String(level)}"`)
  if (!EXTERNAL_AGENT_CAPABILITY_EVIDENCE.includes(evidence)) {
    throw new ManifestError(`${where}: bad evidence "${String(evidence)}"`)
  }
  // `none` is the only evidence grade that admits nothing was measured, so it
  // may not back a positive or a negative verdict — that pairing is how an
  // unmeasured row gets laundered into a claim.
  if (evidence === "none" && level !== "unknown") {
    throw new ManifestError(`${where}: evidence "none" cannot justify level "${level}"`)
  }
  if (level !== "native" && level !== "unknown" && typeof cell.reasonKey !== "string") {
    throw new ManifestError(`${where}: level "${level}" requires a reasonKey`)
  }
  if (cell.reasonKey !== undefined && typeof cell.reasonKey !== "string") {
    throw new ManifestError(`${where}: reasonKey must be a string`)
  }
  return {
    level,
    evidence,
    ...(typeof cell.reasonKey === "string" ? { reasonKey: cell.reasonKey } : {}),
  }
}

let validated: ExternalCapabilityManifest | undefined

/**
 * The parsed, validated manifest.
 *
 * The completeness check is the important one: every registered protocol must
 * carry a cell for every id in the vocabulary. An omitted id would read as
 * "absent", and absent is indistinguishable from unsupported at every call site
 * — so the manifest is required to say `unknown` out loud instead.
 */
export function externalCapabilityManifest(): ExternalCapabilityManifest {
  if (validated) return validated

  const raw = MANIFEST as unknown as Record<string, unknown>
  if (typeof raw.version !== "number") throw new ManifestError("missing numeric `version`")

  const declaredIds = raw.capabilityIds
  if (!Array.isArray(declaredIds)) throw new ManifestError("missing `capabilityIds`")
  const vocabulary = new Set<string>(EXTERNAL_AGENT_CAPABILITY_IDS)
  for (const id of declaredIds) {
    if (!vocabulary.has(String(id)))
      throw new ManifestError(`unknown capability id "${String(id)}"`)
  }
  if (declaredIds.length !== vocabulary.size) {
    throw new ManifestError(
      `capabilityIds lists ${declaredIds.length} of ${vocabulary.size} ids in the vocabulary`
    )
  }

  const protocolsRaw = (raw.protocols ?? {}) as Record<string, Record<string, unknown>>
  const protocolIds = Object.keys(protocolsRaw)
  for (const expected of BUILTIN_EXECUTABLE_EXTERNAL_AGENT_PROTOCOLS) {
    if (!protocolIds.includes(expected))
      throw new ManifestError(`protocol "${expected}" has no row`)
  }
  for (const found of protocolIds) {
    if (!(BUILTIN_EXECUTABLE_EXTERNAL_AGENT_PROTOCOLS as readonly string[]).includes(found)) {
      throw new ManifestError(
        `protocol "${found}" is not a registered built-in protocol — plugin protocols declare ` +
          `their rows in the plugin manifest, and legacy protocols have no adapter`
      )
    }
  }

  const protocols: Record<
    string,
    ExternalCapabilityManifest["protocols"][BuiltinExecutableExternalAgentProtocol]
  > = {}
  for (const [protocol, entry] of Object.entries(protocolsRaw)) {
    const capsRaw = (entry.capabilities ?? {}) as Record<string, unknown>
    const capabilities = {} as Record<ExternalAgentCapabilityId, ExternalAgentCapabilityCell>
    for (const id of EXTERNAL_AGENT_CAPABILITY_IDS) {
      if (!(id in capsRaw)) throw new ManifestError(`protocol "${protocol}" omits "${id}"`)
      capabilities[id] = validateCell(`protocols.${protocol}.${id}`, capsRaw[id])
    }
    for (const id of Object.keys(capsRaw)) {
      if (!vocabulary.has(id))
        throw new ManifestError(`protocol "${protocol}" declares unknown id "${id}"`)
    }
    protocols[protocol] = {
      label: String(entry.label ?? protocol),
      note: String(entry.note ?? ""),
      capabilities,
    }
  }

  const methodsRaw = (raw.adapterMethodCapabilities ?? {}) as Record<string, string>
  for (const id of Object.keys(methodsRaw)) {
    if (!vocabulary.has(id))
      throw new ManifestError(`adapterMethodCapabilities: unknown id "${id}"`)
  }

  const refinementsRaw = (raw.presetRefinements ?? {}) as Record<string, Record<string, unknown>>
  const presetRefinements: Record<string, ExternalCapabilityManifest["presetRefinements"][string]> =
    {}
  for (const [presetId, entry] of Object.entries(refinementsRaw)) {
    const protocol = String(entry.protocol ?? "")
    if (!(protocol in protocols)) {
      throw new ManifestError(`preset "${presetId}" refines unknown protocol "${protocol}"`)
    }
    const capsRaw = (entry.capabilities ?? {}) as Record<string, unknown>
    const capabilities: ExternalAgentCapabilityMatrix = {}
    for (const [id, cell] of Object.entries(capsRaw)) {
      if (!vocabulary.has(id))
        throw new ManifestError(`preset "${presetId}" declares unknown id "${id}"`)
      capabilities[id as ExternalAgentCapabilityId] = validateCell(
        `presetRefinements.${presetId}.${id}`,
        cell
      )
    }
    presetRefinements[presetId] = {
      protocol: protocol as BuiltinExecutableExternalAgentProtocol,
      note: String(entry.note ?? ""),
      capabilities,
    }
  }

  validated = {
    version: raw.version,
    description: String(raw.description ?? ""),
    capabilityIds: declaredIds as readonly ExternalAgentCapabilityId[],
    adapterMethodCapabilities:
      methodsRaw as ExternalCapabilityManifest["adapterMethodCapabilities"],
    protocols: protocols as ExternalCapabilityManifest["protocols"],
    presetRefinements,
  }
  return validated
}

/** Manifest version, stamped onto every profile so a stale one is recognisable. */
export function externalCapabilityManifestVersion(): number {
  return externalCapabilityManifest().version
}

/**
 * Layer 1 for a protocol.
 *
 * A protocol with no manifest row (a plugin protocol, or a legacy `http`
 * config) gets a complete `unknown` row rather than an empty one: the merge
 * relies on every id being present so a later layer's absence cannot silently
 * mean "supported".
 */
export function protocolCapabilityLayer(protocol: string): ExternalAgentCapabilityLayerInput {
  const manifest = externalCapabilityManifest()
  const row = manifest.protocols[protocol as BuiltinExecutableExternalAgentProtocol]
  if (row) return { layer: "protocol", cells: { ...row.capabilities } }

  const cells: ExternalAgentCapabilityMatrix = {}
  for (const id of EXTERNAL_AGENT_CAPABILITY_IDS) {
    cells[id] = { level: "unknown", evidence: "none", reasonKey: "noManifestRow" }
  }
  return { layer: "protocol", cells }
}

/** Layer 2 for a preset. Absent preset ⇒ no refinement, which is not an error. */
export function presetCapabilityLayer(
  presetId: string | undefined
): ExternalAgentCapabilityLayerInput {
  if (!presetId) return { layer: "refinement", cells: {} }
  const entry = externalCapabilityManifest().presetRefinements[presetId]
  return { layer: "refinement", cells: entry ? { ...entry.capabilities } : {} }
}

/**
 * Layer 3: which optional adapter methods actually exist on the instance.
 *
 * Only fills `unknown` (enforced by the merge). That asymmetry is deliberate:
 * a method's presence proves a capability, but its ABSENCE only proves Cognia
 * has not wired it — which is why the negative is recorded as `unsupported`
 * with `adapterMethodMissing` rather than as a statement about the protocol.
 */
export function adapterMethodCapabilityLayer(
  adapter: Record<string, unknown> | undefined
): ExternalAgentCapabilityLayerInput {
  const manifest = externalCapabilityManifest()
  const cells: ExternalAgentCapabilityMatrix = {}
  if (!adapter) return { layer: "adapter-methods", cells }

  for (const [id, method] of Object.entries(manifest.adapterMethodCapabilities)) {
    const implemented = typeof adapter[method] === "function"
    cells[id as ExternalAgentCapabilityId] = implemented
      ? { level: "native", evidence: "adapter-code", reasonKey: `adapterMethod.${method}` }
      : { level: "unsupported", evidence: "adapter-code", reasonKey: "adapterMethodMissing" }
  }
  return { layer: "adapter-methods", cells }
}
