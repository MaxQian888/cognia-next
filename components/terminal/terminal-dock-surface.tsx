"use client"

/**
 * One terminal dock for both shell slots.
 *
 * The shell mounts a `TerminalDockRegion` per physical slot (bottom edge,
 * right column), and each used to render its own `<TerminalDock />`. Moving the
 * dock was therefore a hand-off between two React subtrees: the departing slot
 * unmounted its dock — disposing every xterm instance, its renderer and its
 * addons — and the arriving slot built a fresh one, re-imported xterm, re-sized
 * the PTY and came up with an empty screen, because a same-page remount only
 * drains the bytes that arrived while nothing was listening, not the
 * scrollback. Each move cost a full terminal cold start inside the very frames
 * the move animation needed.
 *
 * React cannot move a subtree between two parents without remounting it, but a
 * DOM node can be moved without React noticing. So the dock renders exactly
 * once, here, through a portal into one detached host node, and each region
 * only *claims* the node for its fixed-size surface. Whichever slot holds the
 * dock gets the node appended into it; a move re-parents the node and the
 * terminal inside it keeps running — xterm, its canvas and its PTY attachment
 * are never touched. Its own `ResizeObserver` re-fits it to the new slot once.
 *
 * Without a provider (a region rendered on its own, as in its unit tests) the
 * region falls back to rendering the dock inline.
 */

import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react"
import { createPortal } from "react-dom"

import { TerminalDock } from "@/components/terminal/terminal-dock"
import type { TerminalPanelPosition } from "@/stores/terminal/terminal-store"

/** What one slot's region reports about itself. */
export interface TerminalDockSurfaceClaim {
  /** The region's fixed-size inner layer, where the dock is drawn. */
  element: HTMLElement | null
  /** True while the slot wants the dock on screen: open, or animating closed. */
  mounted: boolean
  /** True when the store's `panelPosition` is this slot. Breaks a tie. */
  owns: boolean
  /** The measured shell axis the dock's separator resizes against. */
  resizeBasisPx: number | undefined
}

type SurfaceClaims = Partial<Record<TerminalPanelPosition, TerminalDockSurfaceClaim>>

type PublishClaim = (slot: TerminalPanelPosition, claim: TerminalDockSurfaceClaim | null) => void

const TerminalDockSurfaceContext = createContext<PublishClaim | null>(null)

const SLOTS: readonly TerminalPanelPosition[] = ["bottom", "right"]

/**
 * The slot whose surface draws the dock right now, if any.
 *
 * Only one slot is mounted in practice — the region never animates the
 * departing edge of a move — but closing one edge and opening the other within
 * one collapse animation briefly leaves both mounted. The slot the store points
 * at wins then: it is where the user is looking.
 */
export function resolveActiveSurface(
  claims: SurfaceClaims
): { slot: TerminalPanelPosition; claim: TerminalDockSurfaceClaim } | null {
  const candidates = SLOTS.flatMap((slot) => {
    const claim = claims[slot]
    return claim?.mounted && claim.element ? [{ slot, claim }] : []
  })
  return candidates.find((candidate) => candidate.claim.owns) ?? candidates[0] ?? null
}

function sameClaim(
  a: TerminalDockSurfaceClaim | undefined,
  b: TerminalDockSurfaceClaim | null
): boolean {
  if (!a || !b) return !a && !b
  return (
    a.element === b.element &&
    a.mounted === b.mounted &&
    a.owns === b.owns &&
    a.resizeBasisPx === b.resizeBasisPx
  )
}

/**
 * Re-parents the host node into the active surface. A component of its own,
 * rendered *before* the portal, so its layout effect runs ahead of the dock's
 * in the same commit: the dock never mounts into a node that is not yet in the
 * document.
 */
function SurfaceAttacher({ node, host }: { node: HTMLElement; host: HTMLElement | null }) {
  useLayoutEffect(() => {
    if (host) {
      if (node.parentElement !== host) host.appendChild(node)
    } else {
      node.remove()
    }
  }, [host, node])
  useLayoutEffect(() => () => node.remove(), [node])
  return null
}

function createHostNode(): HTMLElement | null {
  if (typeof document === "undefined") return null
  const node = document.createElement("div")
  node.setAttribute("data-testid", "terminal-dock-host")
  // Lays the dock out as a direct child of whichever surface holds it.
  node.style.display = "contents"
  return node
}

export function TerminalDockSurfaceProvider({ children }: { children: ReactNode }) {
  const [claims, setClaims] = useState<SurfaceClaims>({})
  const [node] = useState(createHostNode)
  const publish = useCallback<PublishClaim>((slot, claim) => {
    setClaims((previous) => {
      if (sameClaim(previous[slot], claim)) return previous
      const next = { ...previous }
      if (claim) next[slot] = claim
      else delete next[slot]
      return next
    })
  }, [])
  const active = resolveActiveSurface(claims)

  return (
    <TerminalDockSurfaceContext.Provider value={publish}>
      {children}
      {node ? <SurfaceAttacher node={node} host={active?.claim.element ?? null} /> : null}
      {node && active
        ? createPortal(
            <TerminalDock keepVisible resizeBasisPx={active.claim.resizeBasisPx} />,
            node
          )
        : null}
    </TerminalDockSurfaceContext.Provider>
  )
}

/**
 * Report a slot's surface to the shared dock. Returns `false` when no provider
 * is mounted, in which case the caller draws the dock itself.
 */
export function useTerminalDockSurface(
  slot: TerminalPanelPosition,
  claim: TerminalDockSurfaceClaim
): boolean {
  const publish = useContext(TerminalDockSurfaceContext)
  const { element, mounted, owns, resizeBasisPx } = claim

  useLayoutEffect(() => {
    publish?.(slot, { element, mounted, owns, resizeBasisPx })
  }, [element, mounted, owns, publish, resizeBasisPx, slot])

  useLayoutEffect(() => {
    if (!publish) return
    return () => publish(slot, null)
  }, [publish, slot])

  return publish !== null
}
