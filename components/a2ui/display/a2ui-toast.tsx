"use client"

import { useEffect, memo } from "react"
import { toast } from "sonner"
import type { A2UIComponentProps, A2UIBaseComponent, A2UIStringOrPath } from "@/types/a2ui/schema"
import { useA2UIData } from "../a2ui-context"

export interface A2UIToastComponent extends A2UIBaseComponent {
  component: "Toast"
  message: A2UIStringOrPath
  description?: A2UIStringOrPath
  variant?: "default" | "success" | "error" | "warning" | "info" | "loading"
  duration?: number
  actionLabel?: string
  action?: string
}

export const A2UIToast = memo(function A2UIToast({
  component,
  onAction,
}: A2UIComponentProps<A2UIToastComponent>) {
  const { resolveString } = useA2UIData()
  const message = resolveString(component.message)
  const description = component.description ? resolveString(component.description) : undefined

  useEffect(() => {
    const variant = component.variant || "default"
    const opts: Record<string, unknown> = {
      description,
      duration: component.duration,
    }

    if (component.actionLabel && component.action) {
      opts.action = {
        label: component.actionLabel,
        onClick: () => onAction(component.action!, {}),
      }
    }

    switch (variant) {
      case "success":
        toast.success(message, opts)
        break
      case "error":
        toast.error(message, opts)
        break
      case "warning":
        toast.warning(message, opts)
        break
      case "info":
        toast.info(message, opts)
        break
      case "loading":
        toast.loading(message, opts)
        break
      default:
        toast(message, opts)
    }
  }, [
    message,
    description,
    component.variant,
    component.duration,
    component.actionLabel,
    component.action,
    onAction,
  ])

  return null
})
