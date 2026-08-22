/**
 * Plugin-contributed external-agent PROTOCOL ADAPTERS
 * (`manifest.externalAgentAdapters`).
 *
 * Where `externalAgentPresets` lets a plugin contribute a *configuration*
 * (command + transport + protocol) that piggy-backs on one of the four built-in
 * protocols (acp / codex-app-server / opencode / a2a), an `externalAgentAdapter`
 * lets a plugin contribute the *protocol behaviour itself* — the handshake,
 * session lifecycle, streaming semantics and health-check for a genuinely new
 * external agent. This closes the loop so a plugin can ship a complete,
 * dynamically-loadable external agent (adapter + matching preset).
 *
 * An adapter contribution is CODE: the plugin ships a factory that returns a
 * `ProtocolAdapter` (mirroring `lib/ai/agent/external/protocol-adapter.ts`).
 * The factory module is lazy-imported on plugin enable in the RENDERER (where
 * plugin code legitimately runs) and registered into the external-agent
 * `protocolAdapterRegistry` under the namespaced protocol id `${pluginId}:${id}`
 * so it can never collide with a built-in protocol or another plugin's adapter.
 * Disabling the plugin unregisters every adapter it contributed.
 *
 * The actual subprocess is still spawned by the generic, hardened Rust process
 * layer (`src-tauri/src/external_agent/`); a contributed adapter only owns the
 * renderer-side protocol/session logic — never raw process spawning.
 */

import type { PluginContributionBackend } from "@/types/plugin/plugin"
import type { ExternalAgentCapabilityMatrix } from "@cognia/agent-config-types/external-agent-capability"

/**
 * One protocol-adapter contribution inside
 * `PluginManifest.externalAgentAdapters`.
 */
export interface PluginExternalAgentAdapterDef {
  /**
   * Protocol id. Registered (and referenced by presets) as the namespaced
   * `${pluginId}:${id}`, so a bare id like `"demo"` never shadows a built-in
   * protocol such as `"acp"`.
   */
  id: string
  /** Human-readable label for diagnostics and the contributed-capability tab. */
  label: string
  /** Optional one-line description of the protocol the adapter speaks. */
  description?: string
  /**
   * Relative module path (lazy-imported on enable, renderer-side). REQUIRED —
   * an adapter is always code.
   */
  /**
   * Which runtime owns this factory. Omit to inherit the plugin type
   * (`python` plugins default to `"python"`); declaring `entry` pins it to
   * `"js"`. See {@link PluginContributionBackend}.
   */
  backend?: PluginContributionBackend
  entry?: string
  /**
   * Export name of the adapter factory in `entry`. The export must be a
   * `() => ProtocolAdapter` function. REQUIRED.
   */
  export?: string
  /**
   * Adapter version, recorded on the capability profile.
   *
   * Not the plugin's version: an adapter can be rewritten against a new
   * upstream protocol release without the plugin's own version moving, and the
   * profile digest has to change when that happens or a cached capability
   * answer outlives the adapter it described.
   */
  version?: string
  /**
   * What this adapter's protocol can do (ADR-0090 external SSOT, merge layer 2).
   *
   * OPTIONAL, and its absence is not an error — a plugin written before
   * capability declarations existed keeps loading, with every capability
   * `unknown`. `unknown` never satisfies a hard requirement, so an undeclared
   * adapter degrades to "prove it at the handshake" rather than to a silent yes.
   *
   * This is a REFINEMENT, not an override: it may fill in what the built-in
   * protocol row left unmeasured or tighten what it allowed, and it can never
   * widen a capability the protocol itself refuses. A plugin author is not in a
   * position to overrule the wire format.
   */
  capabilities?: ExternalAgentCapabilityMatrix
}
