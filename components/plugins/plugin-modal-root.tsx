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
 * Error boundary mirrors `<PluginExtensionSlot>` — a single broken modal
 * must not crash the rest of the UI.
 *
 * ADR-0026 §3 §A.
 */

import { Component, type ErrorInfo, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { selectAllModals, usePluginModalStore } from "@/stores/plugin/plugin-modal-store"
import type { PluginModalEntry } from "@/types/plugin/plugin-modal"

interface ModalBoundaryProps {
  pluginId: string
  modalId: string
  children: ReactNode
}

interface ModalBoundaryState {
  hasError: boolean
}

function ModalErrorFallback(): ReactNode {
  const t = useTranslations("plugins.modalRoot")
  return <div className="p-6 text-sm text-destructive">{t("errorFallback")}</div>
}

class PluginModalErrorBoundary extends Component<ModalBoundaryProps, ModalBoundaryState> {
  state: ModalBoundaryState = { hasError: false }

  static getDerivedStateFromError(): ModalBoundaryState {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // The plugin-system logger is not React-aware; downgrade to console.

    console.error(
      `[plugin-modal] ${this.props.pluginId} threw rendering modal ${this.props.modalId}`,
      error,
      info
    )
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return <ModalErrorFallback />
    }
    return this.props.children
  }
}

function renderEntry(entry: PluginModalEntry): ReactNode {
  const Component = entry.component
  const handleClose = (): void => {
    usePluginModalStore.getState().close(entry.modalId)
  }
  return (
    <Dialog
      key={entry.modalId}
      open
      onOpenChange={(open) => {
        if (!open) handleClose()
      }}
    >
      <DialogContent>
        <PluginModalErrorBoundary pluginId={entry.pluginId} modalId={entry.modalId}>
          <Component modalId={entry.modalId} args={entry.args} onClose={handleClose} />
        </PluginModalErrorBoundary>
      </DialogContent>
    </Dialog>
  )
}

export function PluginModalRoot(): ReactNode {
  const modals = usePluginModalStore(selectAllModals)
  if (modals.length === 0) return null
  return <>{modals.map(renderEntry)}</>
}
