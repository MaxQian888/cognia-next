import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"
import { useUIStore } from "@/stores/ui"
import type { Artifact, CanvasDocument } from "@/types"

export function revealArtifactInWorkspace(id: string): Artifact | null {
  const store = useArtifactStore.getState()
  const artifact = store.artifacts[id]

  if (!artifact) {
    return null
  }

  store.setActiveArtifact(id)
  store.openPanel("artifact")
  // Make "open in panel" target the docked panel when one is mounted: expand
  // the desktop dock and open the mobile Sheet fallback. Harmless no-ops when
  // the dock isn't on screen.
  const dock = useArtifactDockLayoutStore.getState()
  dock.setDockCollapsed(false)
  // The artifact surface opens on its preview; ask for it explicitly so a dock
  // parked on (say) the workspace panel follows the artifact you just revealed.
  dock.requestReveal({ panelId: "preview", mode: "narrow" })
  return artifact
}

/**
 * The canvas twin of {@link revealArtifactInWorkspace}.
 *
 * There is deliberately no route to push. The editable canvas surface is
 * `CanvasShell`, which `desktop-chat-workspace.tsx` mounts when the shell's
 * selected guild is `{ kind: "canvas" }` — the app is a static export with no
 * dynamic segments at all, so the `/canvas/<id>` this used to link to never
 * existed and always 404'd. `app/canvas/join/page.tsx` already reveals a shared
 * document exactly this way (store write + guild switch); this is that path,
 * named, so chat cards and the agent's `canvas_open` tool share one seam.
 *
 * Callers that are not already on `/` must route there themselves — `lib/` has
 * no router. `components/shell/use-shell-nav.ts:goHome` is the shape to copy.
 *
 * `openPanel("canvas")` is *not* called: `panelView === "canvas"` has no reader
 * in production (only the store writes it), so the dock's canvas mode renders
 * nothing. `setActiveCanvas` still sets it — that is the store's own long-
 * standing behaviour and is left alone.
 */
export function revealCanvasDocument(id: string): CanvasDocument | null {
  const store = useArtifactStore.getState()
  const document = store.canvasDocuments[id]

  if (!document) {
    return null
  }

  store.setActiveCanvas(id)
  useUIStore.getState().setSelectedGuild({ kind: "canvas" })
  return document
}
