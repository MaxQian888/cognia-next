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

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
} from "react"
import { useTranslations } from "next-intl"
import { AlertTriangleIcon, XIcon } from "lucide-react"
import { A2UISurface } from "@/components/a2ui/a2ui-surface"
import { PluginSurface } from "@/components/plugins/plugin-surface"
import { ResourceWorkbenchChatPanel } from "@/components/context-workbench/resource-workbench-chat-panel"
import { Button } from "@/components/ui/button"
import {
  useTranscriptSelection,
  type SelectionRect,
} from "@/components/chat/message-selection-toolbar"
import {
  resourceWorkbenchSessionId,
  surfaceBindingForContextResource,
} from "@/lib/context-workbench/resource-session"
import { invokePluginTool } from "@/lib/plugin/core/invoke-plugin-tool"
import { loggers } from "@/lib/plugin/core/logger"
import { resolvePluginLabel } from "@/lib/plugin/i18n/plugin-label"
import { useA2UIStore } from "@/stores/a2ui"
import { useArtifactStore } from "@/stores/artifact"
import { useChatStore } from "@/stores/chat"
import { useSessionStore } from "@/stores/chat/session-store"
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
 * What a staged selection is titled: the thing the user was looking at, named
 * the way the rest of the app names it — a file by its file name, a
 * conversation / artifact / canvas document by its title. The raw resource key
 * (`project:<id>:<root>:<path>`) is an address, not a title; it is the last
 * resort only for a record the host has no name for.
 */
export function selectionTitleForResource(resource: ContextResource): string {
  switch (resource.kind) {
    case "project-file": {
      const segments = resource.relPath.split(/[\\/]/).filter(Boolean)
      return segments.at(-1) ?? resource.relPath
    }
    case "session": {
      const title = useSessionStore
        .getState()
        .sessions.find((session) => session.id === resource.sessionId)?.title
      return title?.trim() || getContextResourceKey(resource)
    }
    case "artifact": {
      const title = useArtifactStore.getState().artifacts[resource.artifactId]?.title
      return title?.trim() || getContextResourceKey(resource)
    }
    case "canvas-document": {
      const title = useArtifactStore.getState().canvasDocuments[resource.documentId]?.title
      return title?.trim() || getContextResourceKey(resource)
    }
    case "workflow":
      return getContextResourceKey(resource)
  }
}

/** Space kept between the toolbar and the edges it is clamped against. */
const TOOLBAR_EDGE_GAP = 8

export interface ToolbarBox {
  left: number
  top: number
  right: number
  bottom: number
}

/**
 * Place the selection toolbar under the selection, centred on it, and keep
 * every edge inside `bounds` (the panel intersected with the viewport). It
 * flips above the selection when there is no room below; a toolbar wider than
 * the panel pins to its left edge rather than spilling out of both sides.
 */
export function clampSelectionToolbar(
  selection: SelectionRect,
  size: { width: number; height: number },
  bounds: ToolbarBox,
  gap: number = TOOLBAR_EDGE_GAP
): { left: number; top: number } {
  // `min` wins when the box cannot fit at all: pin to the start edge.
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max))
  const centred = (selection.left + selection.right) / 2 - size.width / 2
  const below = selection.bottom + gap
  const above = selection.top - gap - size.height
  const fitsBelow = below + size.height <= bounds.bottom - gap
  const preferred = !fitsBelow && above >= bounds.top + gap ? above : below
  return {
    left: clamp(centred, bounds.left + gap, bounds.right - gap - size.width),
    top: clamp(preferred, bounds.top + gap, bounds.bottom - gap - size.height),
  }
}

function toolbarBounds(container: HTMLElement | null): ToolbarBox {
  const viewport = {
    left: 0,
    top: 0,
    right: window.innerWidth,
    bottom: window.innerHeight,
  }
  const rect = container?.getBoundingClientRect()
  if (!rect || rect.width === 0 || rect.height === 0) return viewport
  return {
    left: Math.max(rect.left, viewport.left),
    top: Math.max(rect.top, viewport.top),
    right: Math.min(rect.right, viewport.right),
    bottom: Math.min(rect.bottom, viewport.bottom),
  }
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
  const toolbarRef = useRef<HTMLDivElement | null>(null)
  // Escape hides the toolbar for *this* selection; a new selection brings it
  // back. Keyed by content + position because the anchor object is rebuilt on
  // every selectionchange.
  const anchorKey = anchor
    ? `${anchor.text}\u0000${anchor.rect.left}:${anchor.rect.top}:${anchor.rect.right}:${anchor.rect.bottom}`
    : null
  const [dismissedKey, setDismissedKey] = useState<string | null>(null)
  const visible = anchor !== null && anchorKey !== dismissedKey

  const dismiss = useCallback(() => {
    setDismissedKey(anchorKey)
    window.getSelection()?.removeAllRanges()
  }, [anchorKey])

  useEffect(() => {
    if (!visible) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss()
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [dismiss, visible])

  // Measured placement, written straight to the element before paint: the
  // toolbar's size is only known once it is laid out, and a state round trip
  // would paint it once in the wrong place first.
  useLayoutEffect(() => {
    const toolbar = toolbarRef.current
    if (!toolbar || !anchor) return
    const { left, top } = clampSelectionToolbar(
      anchor.rect,
      { width: toolbar.offsetWidth, height: toolbar.offsetHeight },
      toolbarBounds(containerRef.current)
    )
    toolbar.style.left = `${left}px`
    toolbar.style.top = `${top}px`
  }, [anchor, containerRef, visible])

  const stageInMainChat = useCallback(() => {
    if (!anchor) return
    const ref: PluginSelectionRef = {
      kind: "plugin",
      pluginId,
      sourceLabel,
      title: selectionTitleForResource(resource),
      // The address stays the resource key: it is what makes two panels'
      // selections distinct references (`contextSelectionIdentity` keys on
      // `ref ?? title`), and two files can share a file name.
      ref: getContextResourceKey(resource),
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

  if (!anchor || !visible) return null

  return (
    <div
      ref={toolbarRef}
      role="toolbar"
      aria-label={t("pluginPanel.selectionToolbar")}
      data-testid="plugin-panel-selection-toolbar"
      className="pointer-events-auto fixed z-50 flex max-w-[calc(100vw-1rem)] flex-wrap items-center gap-1 rounded-md border bg-popover p-1 shadow-md"
      style={{ left: anchor.rect.left, top: anchor.rect.bottom + TOOLBAR_EDGE_GAP }}
    >
      <Button size="sm" variant="ghost" className="h-9 text-xs sm:h-7" onClick={stageInMainChat}>
        {t("selectionToChat")}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-9 text-xs sm:h-7"
        onClick={() => void askHere()}
      >
        {t("selectionToAside")}
      </Button>
    </div>
  )
}

/*
 * Activation state for declarative A2UI panels, keyed by plugin + surface.
 *
 * The build tool runs from the workbench's `onFirstActivate`, which has no way
 * to hand a result back to the panel it is building — and a failed build used
 * to leave the panel on "waiting for the plugin" forever. The outcome is
 * recorded here instead, where the panel for that surface reads it and offers
 * a retry. A success removes the entry, so only failed builds are retained.
 */
type ActivationState = { status: "running" } | { status: "failed"; message: string }

const activationStates = new Map<string, ActivationState>()
const activationListeners = new Set<() => void>()

function activationKey(pluginId: string, surfaceId: string): string {
  return `${pluginId}\u0000${surfaceId}`
}

function setActivationState(key: string, state: ActivationState | null): void {
  if (state) activationStates.set(key, state)
  else activationStates.delete(key)
  for (const listener of activationListeners) listener()
}

function subscribeActivation(listener: () => void): () => void {
  activationListeners.add(listener)
  return () => {
    activationListeners.delete(listener)
  }
}

function useActivationState(pluginId: string, surfaceId: string): ActivationState | undefined {
  const key = activationKey(pluginId, surfaceId)
  const read = useCallback(() => activationStates.get(key), [key])
  return useSyncExternalStore(subscribeActivation, read, read)
}

/**
 * Invoke a panel's `activateTool` for one resource and record the outcome
 * against its surface. Never throws: one broken plugin must not break the
 * workbench, and the failure is shown on the panel instead.
 */
async function runActivateTool(
  pluginId: string,
  def: PluginA2UIContextPanelDef,
  resource: ContextResource
): Promise<void> {
  const activateTool = def.activateTool
  if (!activateTool) return
  const surfaceId = resolvePanelSurfaceId(def.surface, resource)
  const key = activationKey(pluginId, surfaceId)
  setActivationState(key, { status: "running" })
  try {
    await invokePluginTool(pluginId, activateTool, { resource, surfaceId })
    setActivationState(key, null)
  } catch (error) {
    loggers.manager.error(
      `[context-panels] ${pluginId} panel "${def.id}" activateTool "${activateTool}" failed`,
      error
    )
    setActivationState(key, {
      status: "failed",
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

interface A2UIPanelProps extends ContextPanelRenderProps {
  pluginId: string
  panelId: string
  def: PluginA2UIContextPanelDef
}

function A2UIContextPanel({ pluginId, panelId, def, resource }: A2UIPanelProps) {
  const t = useTranslations("contextWorkbench")
  const tRoot = useTranslations()
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const surfaceId = useMemo(
    () => resolvePanelSurfaceId(def.surface, resource),
    [def.surface, resource]
  )
  // `A2UISurface` renders `null` for a surface that does not exist yet, which
  // for a plugin panel is indistinguishable from a broken one. The panel says
  // so instead, and keeps saying so if the plugin never pushes — unless the
  // build tool failed, in which case it says that and offers a retry.
  const exists = useA2UIStore((state) => surfaceId in state.surfaces)
  const activation = useActivationState(pluginId, surfaceId)
  const retry = useCallback(() => {
    void runActivateTool(pluginId, def, resource)
  }, [def, pluginId, resource])

  // The chip names the source in the user's language: an explicit
  // `selectionLabel` wins (the manifest has no key for it yet), then the
  // panel's own `labelKey` through the plugin bundle, then its literal label.
  const sourceLabel =
    def.selectionLabel ?? resolvePluginLabel(tRoot, pluginId, def.labelKey, def.label)

  return (
    <PluginSurface
      pluginId={pluginId}
      surfaceId={`context-panel-a2ui:${pluginId}:${panelId}`}
      formFactor="panel"
      container={false}
    >
      <div ref={bodyRef} className="h-full">
        {exists ? (
          // The panel slot is the frame: the A2UI `panel` surface type's own
          // `max-w-md` + left border are for a free-standing side panel.
          <A2UISurface surfaceId={surfaceId} className="h-full max-w-none border-l-0" />
        ) : activation?.status === "failed" ? (
          <div role="alert" className="flex flex-col items-start gap-2 p-4 text-sm">
            <p className="flex items-center gap-2 font-medium text-destructive">
              <AlertTriangleIcon className="size-4 shrink-0" aria-hidden />
              {t("pluginPanel.buildFailed")}
            </p>
            {activation.message ? (
              <p className="break-words text-xs text-muted-foreground">
                {t("pluginPanel.buildFailedDetail", { message: activation.message })}
              </p>
            ) : null}
            <Button size="sm" variant="outline" className="h-9 sm:h-8" onClick={retry}>
              {t("pluginPanel.retry")}
            </Button>
          </div>
        ) : (
          <p role="status" className="p-4 text-sm text-muted-foreground">
            {t("a2uiPanelPending")}
          </p>
        )}
      </div>
      {exists && (
        <PanelSelectionToolbar
          containerRef={bodyRef}
          pluginId={pluginId}
          sourceLabel={sourceLabel}
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
  const t = useTranslations("contextWorkbench")
  const contextTool = def.contextTool
  const [contextFailed, setContextFailed] = useState(false)

  // Called by the chat panel at send time, so the tool runs on demand rather
  // than on mount — a wiki page the plugin has not generated yet is not
  // fetched until the user actually asks something.
  //
  // A failure still lets the message go (ungrounded is better than unsent),
  // but it is not silent: the panel says the answer is not grounded in the
  // resource until a later send succeeds or the notice is dismissed.
  const getResourceContext = useCallback(async () => {
    if (!contextTool) return ""
    try {
      const { result } = await invokePluginTool(pluginId, contextTool, { resource })
      setContextFailed(false)
      return readToolText(result)
    } catch (error) {
      loggers.manager.error(
        `[context-panels] ${pluginId} panel "${panelId}" contextTool "${contextTool}" failed`,
        error
      )
      setContextFailed(true)
      return ""
    }
  }, [contextTool, panelId, pluginId, resource])

  const notice = contextFailed ? (
    <div role="status" className="flex items-start gap-2 px-3 py-2 text-xs text-muted-foreground">
      <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <p className="min-w-0 flex-1 break-words">{t("pluginPanel.contextFailed")}</p>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="size-9 shrink-0 sm:size-7"
        aria-label={t("pluginPanel.dismiss")}
        onClick={() => setContextFailed(false)}
      >
        <XIcon className="size-3.5" aria-hidden />
      </Button>
    </div>
  ) : undefined

  return (
    <PluginSurface
      pluginId={pluginId}
      surfaceId={`context-panel-chat:${pluginId}:${panelId}`}
      formFactor="panel"
      container={false}
    >
      <ResourceWorkbenchChatPanel
        getResourceContext={contextTool ? getResourceContext : undefined}
        selectionHeader={notice}
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
  if (!def.activateTool) return undefined
  return (resource: ContextResource) => runActivateTool(pluginId, def, resource)
}
