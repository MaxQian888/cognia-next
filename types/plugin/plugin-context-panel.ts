import type { ComponentType } from "react"
import type { PluginIconName } from "./plugin-icon"
import type {
  CanonicalContextActivity,
  ContextCapability,
  ContextPanelMode,
  ContextPanelRenderProps,
  ContextPanelRetention,
  ContextResourceKind,
} from "@/types/context-workbench"

/**
 * Icon names a contributed panel may name for its activity-rail button.
 *
 * A runtime array for the same reason `CANONICAL_CONTEXT_ACTIVITIES` and
 * `CONTEXT_RESOURCE_READ_PERMISSIONS` are: this list was hand-copied into three
 * places — this union, the host's name→component map, and the manifest
 * validator's allowlist — and only two of them were checked against each other.
 * Names only, so the validator never has to pull `lucide-react` in.
 */
/** @deprecated Use `PluginIconName`; kept as a source-compatible alias. */
export type PluginContextPanelIcon = PluginIconName

interface PluginContextPanelDefBase {
  id: string
  resourceKinds: ContextResourceKind[]
  activity: CanonicalContextActivity
  labelKey: string
  label: string
  icon?: PluginContextPanelIcon
  order?: number
  requiredCapabilities?: ContextCapability[]
  preferredMode?: ContextPanelMode
  retention?: ContextPanelRetention
  /**
   * Mount the panel inside the resource's chat scope. Costs a provisioned
   * session, so only declare it when the panel renders a conversation.
   */
  requiresChatScope?: boolean
}

/** Panel backed by a JS module: `entry`'s `export` is the React renderer. */
export interface PluginModuleContextPanelDef extends PluginContextPanelDefBase {
  /** Optional, and only for symmetry with the declarative kinds. */
  kind?: "module"
  entry: string
  export: string
  /**
   * Named exports resolved from the same `entry` module as the renderer, so a
   * declarative panel can reach the lifecycle and badge hooks the imperative
   * path already had. Behaviour, not data, which is why they are export names
   * rather than inline values — the manifest itself stays serialisable.
   */
  onFirstActivateExport?: string
  onRestoreExport?: string
  getBadgeExport?: string
  webview?: never
}

/**
 * Panel backed by a sandboxed webview: `webview` names an entry of the same
 * manifest's `webviews[]`. The host renders that webview's iframe as the panel
 * body and mirrors the context-panel API into it over postMessage
 * (`acquireCogniaContextPanelApi()`), so there is no module to resolve
 * lifecycle exports from — hence the `never` fields.
 */
export interface PluginWebviewContextPanelDef extends PluginContextPanelDefBase {
  kind?: "webview"
  webview: string
  entry?: never
  export?: never
  onFirstActivateExport?: never
  onRestoreExport?: never
  getBadgeExport?: never
}

/**
 * Fields the declarative kinds must not carry.
 *
 * Written once rather than per interface because the point of a declarative
 * panel is that there is no module to resolve anything from: a `kind: "a2ui"`
 * entry that also named an `entry` would be ambiguous about which body wins,
 * and the manifest validator would have to guess.
 */
interface NoModuleFields {
  entry?: never
  export?: never
  webview?: never
  onFirstActivateExport?: never
  onRestoreExport?: never
  getBadgeExport?: never
}

/**
 * Panel whose body is an A2UI surface the plugin builds and updates.
 *
 * This is the first panel class a Python plugin can declare. Every other kind
 * needs the plugin to hand the host a React component or an HTML document,
 * neither of which survives the NDJSON wire; an A2UI surface is data, pushed
 * with `ctx.a2ui.updateComponents` and answered through the `onA2UIAction`
 * hook the Python runtime has always supported.
 */
export interface PluginA2UIContextPanelDef extends PluginContextPanelDefBase, NoModuleFields {
  kind: "a2ui"
  /**
   * Surface id to render. A `{resourceKey}` placeholder is replaced with the
   * active resource's key (`getContextResourceKey`), so one declaration backs a
   * per-resource surface without the plugin subscribing to anything — it
   * computes the same id and pushes to it.
   */
  surface: string
  /**
   * Tool invoked when the panel is first shown for a resource, with
   * `{ resource, surfaceId }`. This is how a declarative panel gets built:
   * without it the plugin would need a host→plugin callback, which is exactly
   * what a Python plugin cannot receive.
   */
  activateTool?: string
}

/**
 * Panel whose body is a conversation scoped to the active resource — the same
 * side-chat the artifact and canvas surfaces host, contributed by a plugin.
 */
export interface PluginChatContextPanelDef extends PluginContextPanelDefBase, NoModuleFields {
  kind: "chat"
  /**
   * Tool invoked with `{ resource }` to obtain the text the conversation is
   * grounded in. It may return a string, or an object with a `text` field.
   * Without it the panel is an ordinary chat with no resource context.
   */
  contextTool?: string
}

export type PluginContextPanelDef =
  | PluginModuleContextPanelDef
  | PluginWebviewContextPanelDef
  | PluginA2UIContextPanelDef
  | PluginChatContextPanelDef

/** The kinds that carry no module and no webview. */
export const DECLARATIVE_CONTEXT_PANEL_KINDS = ["a2ui", "chat"] as const

export type DeclarativeContextPanelKind = (typeof DECLARATIVE_CONTEXT_PANEL_KINDS)[number]

/** Narrow a manifest entry to a declarative panel. */
export function isDeclarativeContextPanelDef(
  def: PluginContextPanelDef
): def is PluginA2UIContextPanelDef | PluginChatContextPanelDef {
  return def.kind === "a2ui" || def.kind === "chat"
}

export type PluginContextPanelRenderer = ComponentType<ContextPanelRenderProps>
