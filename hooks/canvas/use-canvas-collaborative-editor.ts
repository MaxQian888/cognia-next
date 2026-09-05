"use client"

/**
 * The seam between a Canvas editor and the shared document.
 *
 * # Why the editor asks the registry rather than holding the session
 *
 * The session is created by whichever surface called `connect`, which is the
 * collaboration panel in the right rail. The editor is a sibling. Rather than
 * lift the session into a second state container beside `crdtStore`, this
 * subscribes to the registry and reads the id back, so there is still exactly
 * one place a session exists.
 *
 * # The store keeps being the source of truth for everything except the buffer
 *
 * While a binding is live the `Y.Text` owns the characters, and the artifact
 * store's `content` is a projection of it. That matters because the preview,
 * the export, the AI actions, the version history and the outline all read
 * `content`, and none of them should have to learn what a CRDT is. The
 * projection is debounced for the same reason the editor's own commit was: a
 * store write is a re-render, a localStorage write and an IndexedDB
 * transaction, and none of those belong on a keystroke.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import type { Awareness } from "y-protocols/awareness"
import type { editor as MonacoEditor } from "monaco-editor"
import type { Extension } from "@codemirror/state"

import { crdtStore } from "@/lib/canvas/collaboration/crdt-store"
import {
  awarenessUserFrom,
  bindMonacoEditor,
  codeMirrorCollabExtensions,
  presenceStylesheet,
  resolvePresenceTimeout,
  CANVAS_PRESENCE_STYLE_ID,
  type CanvasPresenceSettings,
} from "@/lib/canvas/collaboration/editor-binding"
import { useCanvasSettingsStore } from "@/stores/canvas/canvas-settings-store"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import type { Participant } from "@/types/canvas/collaboration"
import { loggers } from "@cognia/logging"

const log = loggers.canvas

/** How long the shared text may settle before the projection writes it back. */
export const CANVAS_PROJECTION_DEBOUNCE_MS = 400

/** Referentially stable, so an inactive editor does not reconfigure each render. */
const EMPTY_EXTENSIONS: Extension[] = []

export interface UseCanvasCollaborativeEditorOptions {
  documentId: string | null
  /** The feature flag. When off, nothing binds and nothing is injected. */
  enabled: boolean
}

export interface UseCanvasCollaborativeEditorResult {
  /** True once a session exists for this document and a binding may attach. */
  active: boolean
  /** Attach Monaco. Returns a teardown, or null when there is nothing to bind. */
  bindMonaco: (editor: MonacoEditor.IStandaloneCodeEditor) => Promise<(() => void) | null>
  /** CodeMirror extensions, empty when inactive. */
  codeMirrorExtensions: Extension[]
}

/**
 * Subscribe to the session registry.
 *
 * The snapshot is the session id, a string, so an unchanged session does not
 * re-render the whole editor pane every time a participant's cursor moves.
 */
function useSessionId(documentId: string | null, enabled: boolean): string | null {
  const subscribe = useCallback((listener: () => void) => crdtStore.onSessionsChanged(listener), [])
  const snapshot = useCallback(() => {
    if (!enabled || !documentId) return null
    return crdtStore.sessionIdForDocument(documentId)
  }, [documentId, enabled])
  // The server snapshot is always null: there is no session during SSR, and
  // returning anything else would make the first client render disagree.
  return useSyncExternalStore(subscribe, snapshot, () => null)
}

/** Keep one stylesheet in the head, replaced rather than stacked. */
function usePresenceStylesheet(settings: CanvasPresenceSettings, active: boolean): void {
  const css = useMemo(() => presenceStylesheet(settings), [settings])
  useEffect(() => {
    if (typeof document === "undefined") return
    const existing = document.getElementById(CANVAS_PRESENCE_STYLE_ID)
    if (!active) {
      existing?.remove()
      return
    }
    const element = existing ?? document.createElement("style")
    element.id = CANVAS_PRESENCE_STYLE_ID
    element.textContent = css
    if (!existing) document.head.appendChild(element)
    return () => {
      // Left in place while active so a settings change swaps the text rather
      // than flashing undecorated cursors between renders.
    }
  }, [css, active])
  useEffect(() => {
    return () => {
      if (typeof document !== "undefined") {
        document.getElementById(CANVAS_PRESENCE_STYLE_ID)?.remove()
      }
    }
  }, [])
}

/**
 * Push the idle cutoff onto a live awareness.
 *
 * `outdatedTimeout` is a plain instance field rather than a constructor
 * option, so this is how `presenceTimeout` stops being a stored number and
 * starts deciding when a silent peer leaves the roster.
 */
function applyPresenceTimeout(awareness: Awareness | null, requested: number): void {
  if (!awareness) return
  ;(awareness as unknown as { outdatedTimeout: number }).outdatedTimeout =
    resolvePresenceTimeout(requested)
}

/**
 * Everything one session's binding needs, resolved together.
 *
 * Held as one value rather than three pieces of state so a render can never
 * see an awareness that belongs to a session the extensions do not.
 */
interface CanvasBindingState {
  sessionId: string
  awareness: Awareness
  extensions: Extension[]
}

export function useCanvasCollaborativeEditor(
  options: UseCanvasCollaborativeEditorOptions
): UseCanvasCollaborativeEditorResult {
  const { documentId, enabled } = options
  const collaboration = useCanvasSettingsStore((s) => s.settings.collaboration)
  const sessionId = useSessionId(documentId, enabled && collaboration.enabled)
  const [binding, setBinding] = useState<CanvasBindingState | null>(null)
  // The live awareness, held beside the state so the settings effects can
  // reconfigure it without treating a rendered value as mutable.
  const awarenessRef = useRef<Awareness | null>(null)

  const presence = useMemo<CanvasPresenceSettings>(
    () => ({
      showCursors: collaboration.showCursors,
      showSelections: collaboration.showSelections,
      cursorSmoothing: collaboration.cursorSmoothing,
      presenceTimeout: collaboration.presenceTimeout,
    }),
    [
      collaboration.showCursors,
      collaboration.showSelections,
      collaboration.cursorSmoothing,
      collaboration.presenceTimeout,
    ]
  )

  // Read through a ref inside the async setup so a settings change does not
  // tear the binding down and drop every remote cursor for a frame. The
  // stylesheet is what reflects a change, and it is separate.
  const presenceRef = useRef(presence)
  useEffect(() => {
    presenceRef.current = presence
  }, [presence])

  // A binding left over from the previous document is not this document's
  // binding. Deciding that during render rather than clearing it from a
  // cleanup is what keeps the teardown free of state updates.
  const current = binding && binding.sessionId === sessionId ? binding : null

  usePresenceStylesheet(presence, Boolean(sessionId))

  // One awareness and one extension set per session, torn down with it.
  // Keeping either across sessions would republish this peer's stale state
  // into the next document.
  useEffect(() => {
    if (!sessionId) return
    const doc = crdtStore.getYDoc(sessionId)
    const text = crdtStore.getYText(sessionId)
    if (!doc || !text) return

    let disposed = false
    let created: Awareness | null = null

    void import("y-protocols/awareness")
      .then(async ({ Awareness }) => {
        if (disposed) return
        created = new Awareness(doc)
        awarenessRef.current = created
        applyPresenceTimeout(created, presenceRef.current.presenceTimeout)
        const extensions = await codeMirrorCollabExtensions({
          ytext: text,
          awareness: created,
          settings: presenceRef.current,
        })
        if (disposed) {
          created.destroy()
          return
        }
        setBinding({ sessionId, awareness: created, extensions })
      })
      .catch((error) => {
        log.warn("canvas collaborative binding unavailable", { error: String(error) })
      })

    return () => {
      disposed = true
      if (awarenessRef.current === created) awarenessRef.current = null
      created?.destroy()
    }
  }, [sessionId])

  // A later change to the cutoff reaches the live awareness. Setting it once
  // at construction would make the setting apply only to the next session.
  useEffect(() => {
    applyPresenceTimeout(awarenessRef.current, presence.presenceTimeout)
  }, [presence.presenceTimeout, binding])

  // Publish who this peer is, so remote carets are named and coloured.
  useEffect(() => {
    if (!current) return
    const session = crdtStore.getSession(current.sessionId)
    const localId = crdtStore.getLocalParticipantId()
    const self: Participant | undefined = session?.participants.find(
      (participant) => participant.id === localId
    )
    if (!self) return
    current.awareness.setLocalStateField("user", awarenessUserFrom(self))
  }, [current])

  // The projection back into the artifact store.
  const projectionTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!sessionId || !documentId) return
    const text = crdtStore.getYText(sessionId)
    if (!text) return

    const flush = () => {
      projectionTimer.current = null
      const next = text.toString()
      const store = useArtifactStore.getState()
      const document = store.canvasDocuments[documentId]
      // Guarding on equality keeps a document nobody changed out of the save
      // path entirely, which matters because the store write reaches
      // IndexedDB.
      if (!document || document.content === next) return
      store.updateCanvasDocument(documentId, { content: next, updatedAt: new Date() })
    }
    const observer = () => {
      if (projectionTimer.current) clearTimeout(projectionTimer.current)
      projectionTimer.current = setTimeout(flush, CANVAS_PROJECTION_DEBOUNCE_MS)
    }
    text.observe(observer)
    return () => {
      text.unobserve(observer)
      if (projectionTimer.current) {
        clearTimeout(projectionTimer.current)
        projectionTimer.current = null
      }
      // The last characters typed before a document switch are not worth
      // losing to a pending timer.
      flush()
    }
  }, [sessionId, documentId])

  const bindMonaco = useCallback(
    async (editor: MonacoEditor.IStandaloneCodeEditor) => {
      if (!current) return null
      const text = crdtStore.getYText(current.sessionId)
      if (!text) return null
      try {
        return await bindMonacoEditor(
          { ytext: text, awareness: current.awareness, settings: presenceRef.current },
          editor
        )
      } catch (error) {
        log.warn("canvas monaco binding unavailable", { error: String(error) })
        return null
      }
    },
    [current]
  )

  return {
    active: Boolean(current),
    bindMonaco,
    codeMirrorExtensions: current?.extensions ?? EMPTY_EXTENSIONS,
  }
}

export default useCanvasCollaborativeEditor
