"use client"

/**
 * A2UI Dialog Component
 * Modal dialog with content and actions
 */

import { useTranslations } from "next-intl"
import React, { memo, useRef, useEffect } from "react"
import { cn } from "@/lib/utils"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import type { A2UIComponentProps, A2UIDialogComponent } from "@/types/a2ui/schema"
import { useA2UIData, useA2UIActions } from "../a2ui-context"
import { A2UIChildRenderer } from "../a2ui-child-renderer"
import { useA2UIFocusTrap } from "@/hooks/a2ui/use-a2ui-keyboard"

export const A2UIDialog = memo(function A2UIDialog({
  component,
  onAction,
  onDataChange,
}: A2UIComponentProps<A2UIDialogComponent>) {
  const t = useTranslations("a2ui.controls")
  const { resolveString, resolveBoolean } = useA2UIData()
  const { getBindingPath } = useA2UIActions()

  const contentRef = useRef<HTMLDivElement>(null)
  const { focusFirst } = useA2UIFocusTrap(contentRef)

  const open = resolveBoolean(component.open, false)

  useEffect(() => {
    if (open) {
      const timer = setTimeout(focusFirst, 100)
      return () => clearTimeout(timer)
    }
  }, [open, focusFirst])
  const title = component.title ? resolveString(component.title, "") : ""
  const description = component.description ? resolveString(component.description, "") : ""
  const bindingPath = getBindingPath(component.open)

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen && component.closable === false) return
    if (bindingPath) {
      onDataChange(bindingPath, newOpen)
    }
    if (!newOpen && component.closeAction) {
      onAction(component.closeAction)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={component.closable !== false}
        onEscapeKeyDown={(event) => {
          if (component.closable === false) event.preventDefault()
        }}
        onInteractOutside={(event) => {
          if (component.closable === false) event.preventDefault()
        }}
        className={cn(component.className)}
        style={component.style as React.CSSProperties}
      >
        <DialogHeader className={cn(!title && !description && "sr-only")}>
          <DialogTitle className={cn(!title && "sr-only")}>{title || t("untitled")}</DialogTitle>
          <DialogDescription className={cn(!description && "sr-only")}>
            {description || t("dialogContent")}
          </DialogDescription>
        </DialogHeader>

        <div ref={contentRef} className="py-4">
          {component.children && component.children.length > 0 && (
            <A2UIChildRenderer childIds={component.children} />
          )}
        </div>

        {component.actions && component.actions.length > 0 && (
          <DialogFooter>
            <A2UIChildRenderer childIds={component.actions} />
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
})
