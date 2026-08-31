"use client"

import type {
  PluginContext,
  PluginDefinition,
  PluginModalProps,
  PluginQuickActionInput,
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

export const selectionReferenceActions: PluginQuickActionInput[] = [
  {
    id: "selection-metadata",
    title: "Selection metadata",
    labelKey: "surfaces.selectionMetadata",
    surfaces: ["selection"],
    selection: { input: "metadata", output: "status" },
    run: async (invocation) => ({
      kind: "status",
      message: invocation?.surface === "selection" ? invocation.selection.sourceApp : undefined,
    }),
  },
  {
    id: "selection-text-status",
    title: "Selection text status",
    labelKey: "surfaces.selectionText",
    surfaces: ["selection"],
    selection: { input: "text", output: "status" },
    run: async (invocation) => ({
      kind: "status",
      message:
        invocation?.surface === "selection"
          ? String(Array.from(invocation.selection.text ?? "").length)
          : undefined,
    }),
  },
  {
    id: "selection-preview",
    title: "Preview selection",
    labelKey: "surfaces.selectionPreview",
    surfaces: ["selection"],
    selection: { input: "text", output: "preview" },
    run: async (invocation) => ({
      kind: "text",
      text: invocation?.surface === "selection" ? (invocation.selection.text ?? "") : "",
    }),
  },
  {
    id: "selection-copy",
    title: "Copy transformed selection",
    labelKey: "surfaces.selectionCopy",
    surfaces: ["selection"],
    selection: { input: "text", output: "copy" },
    run: async (invocation) => ({
      kind: "text",
      text: invocation?.surface === "selection" ? (invocation.selection.text ?? "") : "",
    }),
  },
  {
    id: "selection-replace",
    title: "Replace selection",
    labelKey: "surfaces.selectionReplace",
    surfaces: ["selection"],
    selection: { input: "text", output: "replace", origins: ["accessibility"] },
    run: async (invocation) => ({
      kind: "text",
      text: invocation?.surface === "selection" ? (invocation.selection.text ?? "").trim() : "",
    }),
  },
]

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
    context.quickActions.registerMany(selectionReferenceActions)
    return {
      onCommand: async (command) => command === "reference.open",
    }
  },
}

export default definition
