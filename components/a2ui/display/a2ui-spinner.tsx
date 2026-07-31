"use client"

import React, { memo } from "react"
import { cn } from "@/lib/utils"
import { Spinner } from "@/components/ui/spinner"
import { useLoadingI18n } from "@/hooks/ui/use-loading-i18n"
import type { A2UIComponentProps, A2UIBaseComponent } from "@/types/a2ui/schema"

export interface A2UISpinnerComponent extends A2UIBaseComponent {
  component: "Spinner"
  size?: "sm" | "md" | "lg"
  label?: string
}

export const A2UISpinner = memo(function A2UISpinner({
  component,
}: A2UIComponentProps<A2UISpinnerComponent>) {
  const t = useLoadingI18n()

  return (
    <div
      className={cn("flex items-center gap-3 justify-center py-4", component.className)}
      style={component.style as React.CSSProperties}
    >
      {/* The schema's `label` renders as visible text, so it already carries
          the announcement. Only name the glyph when there is no such text —
          otherwise a screen reader hears the same message twice. */}
      <Spinner
        label={component.label ? undefined : t.loading}
        className={
          component.size === "sm" ? "size-4" : component.size === "lg" ? "size-8" : "size-6"
        }
      />
      {component.label && <span className="text-sm text-muted-foreground">{component.label}</span>}
    </div>
  )
})
