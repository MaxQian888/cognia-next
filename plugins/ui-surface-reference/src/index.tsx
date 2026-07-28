"use client"

import type {
  PluginContext,
  PluginDefinition,
  PluginModalProps,
  PluginViewProps,
  TreeDataProvider,
} from "@cognia/plugin-sdk"
import type { ExtensionProps } from "@cognia/plugin-sdk/extensions"
import { Button } from "@cognia/plugin-ui"
import manifestJson from "../plugin.json"

export const REFERENCE_PLUGIN_CSS = `.ref-badge,
[data-tree-node="reference-root"] {
  outline: 2px solid rgb(239, 68, 68);
  outline-offset: 2px;
}`

export const REFERENCE_SURFACE_IDS = [
  "composer-action",
  "composer-menu",
  "context-panel",
  "context-webview",
  "modal",
  "view-container",
  "tree-view",
  "custom-view",
  "webview",
  "message-renderer",
  "tool-renderer",
  "quick-action",
  "config",
] as const

interface ConfigComponentProps {
  config: Record<string, unknown>
  onSave(next: Record<string, unknown>): Promise<void>
}

function ReferenceBadge({ surfaceId }: { surfaceId: string }) {
  if (
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("pluginSurfaceCrash") === surfaceId
  ) {
    throw new Error(`Reference crash: ${surfaceId}`)
  }
  return (
    <span className="ref-badge" data-reference-surface={surfaceId}>
      {surfaceId}
    </span>
  )
}

export function ReferenceComposerAction(_props: ExtensionProps) {
  return <ReferenceBadge surfaceId="composer-action" />
}

export function ReferenceComposerMenu(_props: ExtensionProps) {
  return <ReferenceBadge surfaceId="composer-menu" />
}

export function ReferenceContextPanel() {
  return <ReferenceBadge surfaceId="context-panel" />
}

export function ReferenceContextWebview() {
  return <ReferenceBadge surfaceId="context-webview" />
}

export const referenceTreeProvider: TreeDataProvider = {
  getChildren: () => [
    {
      id: "reference-root",
      label: "tree-view",
      icon: "Network",
    },
  ],
}

export function ReferenceCustomView(_props: PluginViewProps) {
  return <ReferenceBadge surfaceId="custom-view" />
}

export function ReferenceWebview() {
  return <ReferenceBadge surfaceId="webview" />
}

export function ReferenceModal(_props: PluginModalProps) {
  return <ReferenceBadge surfaceId="modal" />
}

export function ReferenceMessageRenderer() {
  return <ReferenceBadge surfaceId="message-renderer" />
}

export function ReferenceToolRenderer() {
  return <ReferenceBadge surfaceId="tool-renderer" />
}

export function ReferenceQuickAction() {
  return <ReferenceBadge surfaceId="quick-action" />
}

export function ReferenceTrayItem() {
  return <ReferenceBadge surfaceId="tray" />
}

export function ReferenceConfig({ config, onSave }: ConfigComponentProps) {
  return (
    <Button type="button" onClick={() => void onSave({ ...config, crashSurface: "" })}>
      <ReferenceBadge surfaceId="config" />
    </Button>
  )
}

const definition: PluginDefinition = {
  manifest: manifestJson as PluginDefinition["manifest"],
  activate: async (context: PluginContext) => {
    context.logger.info("ui-surface-reference activated")
    return {
      onCommand: async (command) => command === "reference.open",
    }
  },
}

export default definition
