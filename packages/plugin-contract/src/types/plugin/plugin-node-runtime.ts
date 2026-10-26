/** Optional Node package owned and shipped by one plugin, never a host dependency. */
export interface PluginNodeRuntimeDeclaration {
  /** Plugin-relative directory containing package.json and the pinned dependency lockfile. */
  directory: string
  /** JavaScript entry relative to directory; only loaded by an explicit probe. */
  entry: string
}

export interface PluginNodeRuntimeStatus {
  state: "missing" | "preparing" | "prepared" | "failed"
  prepared: boolean
  /** Fingerprint of the declared package inputs, not a document-conversion capability. */
  fingerprint: string
  updatedAt: number
  packageManager: string
  error?: { code: string; message: string }
  /** JSON reported by the short-lived probe subprocess; no persistent service is implied. */
  probe?: unknown
}

export interface PluginNodeRuntimeAPI {
  /** Read host metadata only; never installs packages or imports the module. */
  status: () => Promise<PluginNodeRuntimeStatus>
  /** Explicitly start preparation; poll status until prepared/failed. */
  prepare: () => Promise<PluginNodeRuntimeStatus>
  /** Request cancellation of an active preparation; poll until cleanup completes. */
  cancel: () => Promise<PluginNodeRuntimeStatus>
  /** Explicitly load the prepared entry in a bounded, short-lived host subprocess. */
  probe: () => Promise<PluginNodeRuntimeStatus>
  /** Remove only this plugin's private prepared runtime; refuses while busy. */
  remove: () => Promise<PluginNodeRuntimeStatus>
}
