"use client"

/**
 * Renderer factories for the two *declarative* context-panel kinds.
 *
 * Every other panel class hands the host something only JavaScript can produce
 * — a React component (`entry` + `export`) or an HTML document (`webview`).
 * Neither survives the NDJSON wire a Python plugin speaks, which is why
 * `contextPanels` was flatly rejected for `type: "python"` until ADR-0145.
 *
 * These two are data instead:
 *
 * - `kind: "a2ui"` renders a surface the plugin pushes with
 *   `ctx.a2ui.updateComponents`; clicks come back through the `onA2UIAction`
 *   hook, which the Python runtime has always supported.
 * - `kind: "chat"` renders the same side conversation the artifact and canvas
 *   surfaces host, grounded in text the host obtains by invoking one of the
 *   plugin's own tools.
 *
 * Neither factory closes over plugin code: they close over a manifest entry
 * plus `invokePluginTool`, so the same declaration behaves identically whether
 * the plugin is TypeScript, Python or hybrid.
 */

import { useCallback, useMemo, useRef, type ComponentType } from "react"
import { useTranslations } from "next-intl"
import { A2UISurface } from "@/components/a2ui/a2ui-surface"
import { PluginSurface } from "@/components/plugins/plugin-surface"
import { ResourceWorkbenchChatPanel } from "@/components/context-workbench/resource-workbench-chat-panel"
import { Button } from "@/components/ui/button"
import { useTranscriptSelection } from "@/components/chat/message-selection-toolbar"
import {
  resourceWorkbenchSessionId,
  surfaceBindingForContextResource,
} from "@/lib/context-workbench/resource-session"
import { invokePluginTool } from "@/lib/plugin/core/invoke-plugin-tool"
import { loggers } from "@/lib/plugin/core/logger"
import { useA2UIStore } from "@/stores/a2ui"
import { useChatStore } from "@/stores/chat"
import type { PluginSelectionRef } from "@/types/artifact/artifact"
import {
  getContextResourceKey,
  type ContextPanelRenderProps,
  type ContextResource,
} from "@/types/context-workbench"
import type {
  PluginA2UIContextPanelDef,
  PluginChatContextPanelDef,
} from "@/types/plugin/plugin-context-panel"

/** `{resourceKey}` is the only placeholder — one declaration, one surface per resource. */
export function resolvePanelSurfaceId(template: string, resource: ContextResource): string {
  return template.replaceAll("{resourceKey}", getContextResourceKey(resource))
}

/**
 * Normalize whatever a plugin tool returned into panel context text.
 *
 * A tool that returns a bare string is the common case; `{ text }` is accepted
 * because a Python tool returning a dict is more natural than returning a
 * scalar, and both spellings mean the same thing. Anything else is dropped
 * rather than stringified — `[object Object]` in a system prompt is worse than
 * no context at all.
 */
export function readToolText(result: unknown): string {
  if (typeof result === "string") return result
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const text = (result as { text?: unknown }).text
    if (typeof text === "string") return text
  }
  return ""
}

/**
 * Two ways out of a plugin panel for the text the user just highlighted.
 *
 * A reader that cannot hand a paragraph to a conversation is a dead end, and
 * before this the only text a user could stage was a chat message or a file —
 * a plugin's own surface had no route at all. Both destinations are real
 * conversations: the main one gets a staged context chip (so the excerpt is
 * folded into the next prompt with its source), and the resource's side chat
 * gets the quote appended to its composer, un-sent, because the selection is
 * the subject and not yet the question.
 */
function PanelSelectionToolbar({
  containerRef,
  pluginId,
  sourceLabel,
  resource,
}: {
  containerRef: React.RefObject<HTMLElement | null>
  pluginId: string
  sourceLabel: string
  resource: ContextResource
}) {
  const t = useTranslations("contextWorkbench")
  const anchor = useTranscriptSelection(containerRef)

  const stageInMainChat = useCallback(() => {
    if (!anchor) return
    const ref: PluginSelectionRef = {
      kind: "plugin",
      pluginId,
      sourceLabel,
      title: getContextResourceKey(resource),
      snapshot: anchor.text,
      comment: "",
    }
    useChatStore.getState().addContextSelection(ref)
    window.getSelection()?.removeAllRanges()
  }, [anchor, pluginId, resource, sourceLabel])

  const askHere = useCallback(async () => {
    if (!anchor) return
    const binding = surfaceBindingForContextResource(resource)
    if (!binding) return
    const { dispatchComposerAppend } = await import("@/components/chat/composer")
    dispatchComposerAppend({
      text: `${anchor.text
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n")}\n\n`,
      sessionId: resourceWorkbenchSessionId(binding),
    })
    window.getSelection()?.removeAllRanges()
  }, [anchor, resource])

  if (!anchor) return null

  return (
    <div
      className="pointer-events-auto fixed z-50 flex items-center gap-1 rounded-md border bg-popover p-1 shadow-md"
      style={{ left: Math.max(8, anchor.x - 160), top: anchor.y + 8 }}
    >
      <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={stageInMainChat}>
        {t("selectionToChat")}
      </Button>
      <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => void askHere()}>
        {t("selectionToAside")}
      </Button>
    </div>
  )
}

interface A2UIPanelProps extends ContextPanelRenderProps {
  pluginId: string
  panelId: string
  def: PluginA2UIContextPanelDef
}

function A2UIContextPanel({ pluginId, panelId, def, resource }: A2UIPanelProps) {
  const t = useTranslations("contextWorkbench")
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const surfaceId = useMemo(
    () => resolvePanelSurfaceId(def.surface, resource),
    [def.surface, resource]
  )
  // `A2UISurface` renders `null` for a surface that does not exist yet, which
  // for a plugin panel is indistinguishable from a broken one. The panel says
  // so instead, and keeps saying so if the plugin never pushes.
  const exists = useA2UIStore((state) => surfaceId in state.surfaces)

  return (
    <PluginSurface
      pluginId={pluginId}
      surfaceId={`context-panel-a2ui:${pluginId}:${panelId}`}
      formFactor="panel"
      container={false}
    >
      <div ref={bodyRef} className="h-full">
        {exists ? (
          <A2UISurface surfaceId={surfaceId} />
        ) : (
          <p className="p-4 text-sm text-muted-foreground">{t("a2uiPanelPending")}</p>
        )}
      </div>
      {exists && (
        <PanelSelectionToolbar
          containerRef={bodyRef}
          pluginId={pluginId}
          sourceLabel={def.selectionLabel ?? def.label}
          resource={resource}
        />
      )}
    </PluginSurface>
  )
}

/** Build the React renderer for a `kind: "a2ui"` manifest entry. */
export function createA2UIContextPanelRenderer(
  pluginId: string,
  def: PluginA2UIContextPanelDef
): ComponentType<ContextPanelRenderProps> {
  function PluginA2UIPanel(props: ContextPanelRenderProps) {
    return <A2UIContextPanel {...props} pluginId={pluginId} panelId={def.id} def={def} />
  }
  PluginA2UIPanel.displayName = `PluginA2UIContextPanel(${pluginId}:${def.id})`
  return PluginA2UIPanel
}

interface ChatPanelProps extends ContextPanelRenderProps {
  pluginId: string
  panelId: string
  def: PluginChatContextPanelDef
}

function ChatContextPanel({ pluginId, panelId, def, resource }: ChatPanelProps) {
  const contextTool = def.contextTool

  // Called by the chat panel at send time, so the tool runs on demand rather
  // than on mount — a wiki page the plugin has not generated yet is not
  // fetched until the user actually asks something.
  const getResourceContext = useCallback(async () => {
    if (!contextTool) return ""
    try {
      const { result } = await invokePluginTool(pluginId, contextTool, { resource })
      return readToolText(result)
    } catch (error) {
      loggers.manager.error(
        `[context-panels] ${pluginId} panel "${panelId}" contextTool "${contextTool}" failed`,
        error
      )
      return ""
    }
  }, [contextTool, panelId, pluginId, resource])

  return (
    <PluginSurface
      pluginId={pluginId}
      surfaceId={`context-panel-chat:${pluginId}:${panelId}`}
      formFactor="panel"
      container={false}
    >
      <ResourceWorkbenchChatPanel
        getResourceContext={contextTool ? getResourceContext : undefined}
      />
    </PluginSurface>
  )
}

/** Build the React renderer for a `kind: "chat"` manifest entry. */
export function createChatContextPanelRenderer(
  pluginId: string,
  def: PluginChatContextPanelDef
): ComponentType<ContextPanelRenderProps> {
  function PluginChatPanel(props: ContextPanelRenderProps) {
    return <ChatContextPanel {...props} pluginId={pluginId} panelId={def.id} def={def} />
  }
  PluginChatPanel.displayName = `PluginChatContextPanel(${pluginId}:${def.id})`
  return PluginChatPanel
}

/**
 * `onFirstActivate` for an A2UI panel, or `undefined` when it declares no
 * build tool.
 *
 * This is the whole reason `activateTool` exists. A JS panel builds itself in
 * its own component; a declarative panel has no code running in the renderer,
 * so *something* has to tell the plugin "the user is looking at this resource
 * now, push a surface". A host→plugin callback cannot cross the wire — a tool
 * invocation can, and it is the same call shape both runtimes already handle.
 */
export function declarativeFirstActivate(
  pluginId: string,
  def: PluginA2UIContextPanelDef
): ((resource: ContextResource) => Promise<void>) | undefined {
  const activateTool = def.activateTool
  if (!activateTool) return undefined
  return async (resource: ContextResource) => {
    const surfaceId = resolvePanelSurfaceId(def.surface, resource)
    try {
      await invokePluginTool(pluginId, activateTool, { resource, surfaceId })
    } catch (error) {
      loggers.manager.error(
        `[context-panels] ${pluginId} panel "${def.id}" activateTool "${activateTool}" failed`,
        error
      )
    }
  }
}
