"use client"

import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import type { UIMessage } from "ai"
import { useTranslations } from "next-intl"
import { MessageRenderer } from "@/components/chat/message-renderer"
import { MCPToolCard } from "@/components/chat/message-parts/mcp-tool-card"
import { PluginQuickActionsMenu } from "@/components/chat/composer/plugin-quick-actions-menu"
import { PluginContextPanelSurface } from "@/components/context-workbench/context-workbench"
import { PluginConfigFormBody } from "@/components/plugins/detail/plugin-config-form"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
import { PluginExtensionSlotWithOverflow } from "@/components/plugins/plugin-extension-slot-with-overflow"
import { PluginViewContainerPanel } from "@/components/shell/plugin-view-container-panel"
import { TooltipProvider } from "@/components/ui/tooltip"
import { contextPanelRegistry } from "@/lib/context-workbench/panel-registry"
import { resolvePluginLabel } from "@/lib/plugin/i18n/plugin-label"
import { openDeclaredModal, usePluginModalStore } from "@/stores/plugin-runtime/plugin-modal-store"
import { usePluginStore } from "@/stores/plugin-runtime"
import { useSettingsStore } from "@/stores/settings"
import type { ContextResource } from "@/types/context-workbench"

const PLUGIN_ID = "ui-surface-reference"
const HARNESS_PATH = "/e2e/plugin-ui-surfaces"
/** The route never changes under a mounted harness — nothing to subscribe to. */
const subscribeNothing = () => () => {}
const REFERENCE_RESOURCE: ContextResource = {
  kind: "session",
  sessionId: "plugin-surface-reference",
  capabilities: [],
}

const REFERENCE_MESSAGE = {
  id: "plugin-surface-reference-message",
  role: "assistant",
  parts: [{ type: "ui-surface-reference" }],
} as unknown as UIMessage

const REFERENCE_TOOL_PART = {
  type: "dynamic-tool",
  toolName: "ui_surface_reference",
  toolCallId: "plugin-surface-reference-tool",
  state: "output-available",
  input: {},
  output: {},
}

function SurfaceCase({
  id,
  label,
  children,
}: {
  id: string
  label: string
  children: React.ReactNode
}) {
  return (
    <section data-reference-case={id}>
      <span data-reference-label={id}>{label}</span>
      {children}
    </section>
  )
}

/**
 * E2E-only acceptance surface. It enables the real in-tree plugin through
 * PluginManager, then mounts the production hosts against the registries the
 * manager populated. It intentionally contains no PluginSurface of its own.
 *
 * It brings its own `TooltipProvider`. `app/layout.tsx` mounts this harness
 * above `AccountGate`, so that it is reachable on a locked or first-run boot —
 * but the app's provider lives *inside* the gate, and `MessageRenderer` renders
 * tooltips. Without one here the harness threw "`Tooltip` must be used within
 * `TooltipProvider`" straight into the layout error boundary, which took the
 * whole page down before a single surface mounted.
 */
export function PluginSurfaceReferenceHarness({ force = false }: { force?: boolean }) {
  const [bootError, setBootError] = useState<string | null>(null)
  const [pluginReady, setPluginReady] = useState(false)
  const modalOpened = useRef(false)
  const plugin = usePluginStore((state) => state.plugins[PLUGIN_ID])
  const pluginT = useTranslations()

  // Route match read through the store protocol rather than an effect: the
  // prerendered frame has no `window`, so the server snapshot answers `force`
  // and the client snapshot takes over at hydration — one render, no
  // setState-in-effect cascade.
  const active = useSyncExternalStore(
    subscribeNothing,
    () => force || window.location.pathname === HARNESS_PATH,
    () => force
  )
  // Re-render whenever the panel registry mutates; `resolve` below reads it.
  useSyncExternalStore(
    contextPanelRegistry.subscribe,
    contextPanelRegistry.getRevision,
    contextPanelRegistry.getRevision
  )
  useEffect(() => {
    if (!active) return
    const requested =
      new URLSearchParams(window.location.search).get("pluginSurfaceLocale") === "zh-CN"
        ? "zh-CN"
        : "en"
    void useSettingsStore
      .getState()
      .setLanguage(requested)
      .then(() => useSettingsStore.setState({ loaded: true }))
      .catch((error) => setBootError(String(error)))
  }, [active])

  useEffect(() => {
    if (!active || pluginReady || !plugin || plugin.status === "loading") {
      return
    }
    let cancelled = false
    let retryTimer: number | undefined
    void import("@/lib/plugin/core/manager")
      .then(({ getPluginManager }) => {
        const enableWhenInitialized = (): void => {
          if (cancelled) return
          const manager = getPluginManager()
          if (!manager.isInitialized()) {
            retryTimer = window.setTimeout(enableWhenInitialized, 50)
            return
          }
          void manager
            .enablePlugin(PLUGIN_ID, "e2e-reference")
            .then(() => {
              if (!cancelled) setPluginReady(true)
            })
            .catch((error) => {
              if (!cancelled) setBootError(String(error))
            })
        }
        enableWhenInitialized()
      })
      .catch((error) => {
        if (!cancelled) setBootError(String(error))
      })
    return () => {
      cancelled = true
      if (retryTimer !== undefined) window.clearTimeout(retryTimer)
    }
  }, [active, plugin, pluginReady])

  useEffect(() => {
    if (!pluginReady || plugin?.status !== "enabled" || modalOpened.current) return
    modalOpened.current = true
    void openDeclaredModal(PLUGIN_ID, "reference-modal").then((modalId) => {
      // i18n-exempt: harness diagnostic read by the spec, not UI prose — same
      // class as an Error message, and never rendered to a product user.
      if (!modalId) setBootError("Reference modal did not register")
    })
    return () => {
      usePluginModalStore.getState().closeAll()
    }
  }, [plugin?.status, pluginReady])

  if (!active) return null
  if (bootError) {
    return <output data-testid="plugin-surface-reference-error">{bootError}</output>
  }
  if (!pluginReady || plugin?.status !== "enabled") {
    // The spec waits on the test id, so the state needs no words of its own —
    // and inventing product translations for an E2E fixture would push
    // test-only keys into the shipped en/zh bundles.
    return <output data-testid="plugin-surface-reference-loading" aria-busy="true" />
  }

  const label = (key: string, fallback: string) =>
    resolvePluginLabel(pluginT as never, PLUGIN_ID, key, fallback)
  const panels = contextPanelRegistry.resolve(REFERENCE_RESOURCE)
  const modulePanel = panels.find((panel) => panel.id === `${PLUGIN_ID}:reference-panel`)
  const webviewPanel = panels.find((panel) => panel.id === `${PLUGIN_ID}:reference-webview-panel`)
  const ModulePanel = modulePanel?.renderer
  const WebviewPanel = webviewPanel?.renderer

  return (
    <TooltipProvider>
      <main data-testid="plugin-surface-reference-harness">
        {/* The control for style containment: host DOM carrying the plugin's own
          class name, outside every `[data-plugin-root]`. The plugin's sheet must
          not reach it. Deliberately empty — the spec reads its computed style,
          never its text, so there is nothing here to translate. */}
        <span className="ref-badge" data-testid="host-ref-badge" aria-hidden />

        <SurfaceCase
          id="composer-action"
          label={label("surfaces.composerAction", "Composer action")}
        >
          <PluginExtensionSlot point="chat.input.actions" />
        </SurfaceCase>
        <SurfaceCase id="composer-menu" label={label("surfaces.composerMenu", "Composer menu")}>
          <PluginExtensionSlotWithOverflow
            point="chat.input.menu"
            limit={0}
            overflowLabel={label("surfaces.composerMenu", "Composer menu")}
          />
        </SurfaceCase>
        {ModulePanel ? (
          <SurfaceCase id="context-panel" label={label("surfaces.contextPanel", "Context panel")}>
            <PluginContextPanelSurface pluginId={PLUGIN_ID} panelId={modulePanel.id}>
              <ModulePanel
                workbenchInstanceId="plugin-surface-reference"
                resource={REFERENCE_RESOURCE}
                active
              />
            </PluginContextPanelSurface>
          </SurfaceCase>
        ) : null}
        {WebviewPanel ? (
          <SurfaceCase
            id="context-webview"
            label={label("surfaces.contextWebview", "Context webview")}
          >
            <WebviewPanel
              workbenchInstanceId="plugin-surface-reference"
              resource={REFERENCE_RESOURCE}
              active
            />
          </SurfaceCase>
        ) : null}
        {/* The production PluginModalRoot is mounted globally in app/layout;
            this marker keeps the reference inventory ordered without creating
            a second root that would render every declared modal twice. */}
        <SurfaceCase id="modal" label={label("surfaces.modal", "Modal")}>
          {null}
        </SurfaceCase>
        <SurfaceCase
          id="view-container"
          label={label("surfaces.viewContainer", "Reference surfaces")}
        >
          <PluginViewContainerPanel containerId={`${PLUGIN_ID}:reference`} />
        </SurfaceCase>
        <SurfaceCase
          id="message-renderer"
          label={label("surfaces.messageRenderer", "Message renderer")}
        >
          <MessageRenderer message={REFERENCE_MESSAGE} />
        </SurfaceCase>
        <SurfaceCase id="tool-renderer" label={label("surfaces.toolRenderer", "Tool renderer")}>
          <MCPToolCard part={REFERENCE_TOOL_PART as never} />
        </SurfaceCase>
        <SurfaceCase id="quick-action" label={label("surfaces.quickAction", "Quick action")}>
          <PluginQuickActionsMenu />
        </SurfaceCase>
        <SurfaceCase id="config" label={label("surfaces.config", "Configuration")}>
          <PluginConfigFormBody pluginId={PLUGIN_ID} plugin={plugin as never} onClose={() => {}} />
        </SurfaceCase>
      </main>
    </TooltipProvider>
  )
}
