/**
 * Plugin SDK — `extensions` subpath.
 *
 * Re-exports the canonical extension-point identifiers a plugin targets
 * when mounting React components into host UI slots, plus the contract
 * shape governance/diagnostics tools use to audit slot coverage.
 *
 * Sources:
 *  - `lib/plugin/contracts/plugin-points.ts` — canonical extension-point
 *    enumeration, contract shapes, and the read-only
 *    `getExtensionPointContract(id)` accessor.
 *  - `types/plugin/plugin-extended.ts` — `ExtensionPoint` alias and the
 *    `ExtensionOptions` / `ExtensionRegistration` / `ExtensionProps`
 *    surfaces consumed by `PluginExtensionAPI.register(...)`.
 *
 * The runtime API (`PluginExtensionAPI`) lives on the extended
 * `PluginContext` and is re-exported from `@cognia/plugin-sdk/context`.
 * The host mounts slots via `<PluginExtensionSlot id="..." />` (internal
 * component) — plugins never instantiate that themselves.
 */

export {
  CANONICAL_EXTENSION_POINTS,
  getExtensionPointContract,
} from "@/lib/plugin/contracts/plugin-points"

export type {
  CanonicalExtensionPoint,
  PluginPointContract,
  PluginPointKind,
  PluginPointStability,
  PluginPointStatus,
  PluginPointGovernanceMode,
  PluginPointProofAudit,
  PluginPointDiagnostic,
  PluginPointValidationOutcome,
} from "@/lib/plugin/contracts/plugin-points"

export type {
  ExtensionPoint,
  ExtensionOptions,
  ExtensionRegistration,
  ExtensionProps,
} from "@/types/plugin/plugin-extended"
