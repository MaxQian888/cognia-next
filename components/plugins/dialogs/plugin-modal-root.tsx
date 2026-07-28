"use client"

/**
 * Host component that renders the current plugin modal stack.
 *
 * Mounted once near the root of the app tree (typically `app/layout.tsx`).
 * Reads from `usePluginModalStore` and renders each open entry inside a
 * shadcn `Dialog`. Stacked modals are rendered one after another so the
 * Z-order matches the open order (latest open is on top).
 *
 * Plugin-supplied components receive `{ onClose, modalId, args }` and are
 * expected to invoke `onClose()` when the user dismisses. The host also
 * pops the stack when the `Dialog`'s `onOpenChange` fires false (e.g. the
 * user clicks outside or presses Escape).
 *
 * `entry.options` chooses the shell: the centered `Dialog` (the default, and
 * what every pre-options caller still gets) or a `Sheet` anchored right/bottom.
 * Both are the same Radix Dialog primitive underneath, so the close, escape,
 * overlay-click and focus-trap contracts are identical across variants — which
 * is exactly why the sheet variants reuse `components/ui/sheet` instead of
 * hand-rolling a positioned dialog.
 *
 * Error boundary mirrors `<PluginExtensionSlot>` — a single broken modal
 * must not crash the rest of the UI.
 *
 * ADR-0026 §3 §A.
 */

import type { ReactNode } from "react"
import { PluginSurface } from "@/components/plugins/plugin-surface"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { Sheet, SheetContent } from "@/components/ui/sheet"
import { cn } from "@/lib/utils"
import { selectAllModals, usePluginModalStore } from "@/stores/plugin-runtime/plugin-modal-store"
import {
  resolvePluginModalOptions,
  type PluginModalEntry,
  type PluginModalSize,
} from "@/types/plugin/plugin-modal"

/**
 * Size presets, one map per variant because the axis a size controls differs:
 * width for the dialog and the right sheet, height for the bottom sheet.
 *
 * `md` on the centered variant is deliberately the empty string — it must
 * resolve to `DialogContent`'s own `sm:max-w-lg`, byte for byte, so that a
 * modal opened without options renders exactly as it did before this existed.
 * Every other cell is a tailwind-merge override of that same base class.
 */
const CENTER_SIZE_CLASS: Record<PluginModalSize, string> = {
  sm: "sm:max-w-sm",
  md: "",
  lg: "sm:max-w-3xl",
  // Not `w-screen`: the dialog is centered with a translate, so an edge-to-edge
  // box has no visible boundary and its close button lands under the window
  // chrome. An inset full-bleed keeps the dismiss affordance reachable.
  full: "h-[calc(100dvh-4rem)] max-w-[calc(100%-4rem)] sm:max-w-[calc(100%-4rem)]",
}

const SHEET_RIGHT_SIZE_CLASS: Record<PluginModalSize, string> = {
  sm: "sm:max-w-sm",
  md: "sm:max-w-md",
  lg: "sm:max-w-2xl",
  full: "w-screen sm:max-w-none",
}

const SHEET_BOTTOM_SIZE_CLASS: Record<PluginModalSize, string> = {
  sm: "h-1/3",
  md: "h-1/2",
  lg: "h-3/4",
  full: "h-dvh",
}

function renderEntry(entry: PluginModalEntry): ReactNode {
  const Component = entry.component
  const { size, variant } = resolvePluginModalOptions(entry.options)
  const handleClose = (): void => {
    usePluginModalStore.getState().close(entry.modalId)
  }
  const body = (
    <PluginSurface
      pluginId={entry.pluginId}
      surfaceId={`modal:${entry.modalId}`}
      formFactor="panel"
      container={false}
    >
      <Component modalId={entry.modalId} args={entry.args} onClose={handleClose} />
    </PluginSurface>
  )
  const handleOpenChange = (open: boolean): void => {
    if (!open) handleClose()
  }

  if (variant === "center") {
    return (
      <Dialog key={entry.modalId} open onOpenChange={handleOpenChange}>
        <DialogContent
          className={CENTER_SIZE_CLASS[size]}
          data-plugin-modal-variant={variant}
          data-plugin-modal-size={size}
        >
          {body}
        </DialogContent>
      </Dialog>
    )
  }

  const side = variant === "sheet-right" ? "right" : "bottom"
  return (
    <Sheet key={entry.modalId} open onOpenChange={handleOpenChange}>
      <SheetContent
        side={side}
        className={cn(
          // `SheetContent` ships without padding (its own Header/Footer carry
          // it) while `DialogContent` has `p-6`. Plugin bodies are written
          // against one contract, so normalise to the dialog's. Scrolling is on
          // the shell rather than the plugin because a sheet has a fixed extent
          // along its anchored axis — overflow here would just be clipped.
          "overflow-y-auto p-6",
          side === "right" ? SHEET_RIGHT_SIZE_CLASS[size] : SHEET_BOTTOM_SIZE_CLASS[size]
        )}
        data-plugin-modal-variant={variant}
        data-plugin-modal-size={size}
      >
        {body}
      </SheetContent>
    </Sheet>
  )
}

export function PluginModalRoot(): ReactNode {
  const modals = usePluginModalStore(selectAllModals)
  if (modals.length === 0) return null
  return <>{modals.map(renderEntry)}</>
}
