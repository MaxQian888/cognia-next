/**
 * Shared inspect row used by SystemTaskInspectSheet (3-column platform vs
 * metadata comparison) and by every unified detail sub-view (simple
 * label + value pair).
 *
 * When `compareValue` is supplied the row renders three columns and
 * highlights mismatches; otherwise it renders the simpler two-column form.
 *
 * Extracted from `system-task-inspect-sheet.tsx` (where it lived inline).
 */

import React from "react"
import { cn } from "@/lib/utils"

export interface InspectRowProps {
  label: string
  /** Primary value to render. Empty strings render as "-". */
  value: string | React.ReactNode
  /**
   * Optional comparison value. When provided, the row renders 3 columns
   * (label | value | compareValue) and highlights the two value columns in
   * amber when they differ. Used by `SystemTaskInspectSheet` to compare
   * platform-reported state against the metadata store.
   */
  compareValue?: string | React.ReactNode
}

export function InspectRow({ label, value, compareValue }: InspectRowProps) {
  if (compareValue !== undefined) {
    const v = typeof value === "string" ? value : ""
    const c = typeof compareValue === "string" ? compareValue : ""
    const mismatch = v !== c && v !== "" && c !== ""
    return (
      <div className="grid grid-cols-[1fr_1fr_1fr] gap-2 py-1.5 border-b border-border/40 text-xs">
        <span className="font-medium text-muted-foreground">{label}</span>
        <span className={cn(mismatch && "text-amber-600 font-medium")}>{renderCell(value)}</span>
        <span className={cn(mismatch && "text-amber-600 font-medium")}>
          {renderCell(compareValue)}
        </span>
      </div>
    )
  }
  return (
    <div className="grid grid-cols-[1fr_2fr] gap-2 py-1.5 border-b border-border/40 text-xs">
      <span className="font-medium text-muted-foreground">{label}</span>
      <span>{renderCell(value)}</span>
    </div>
  )
}

function renderCell(v: string | React.ReactNode): React.ReactNode {
  if (typeof v === "string") return v.length > 0 ? v : "-"
  return v
}
