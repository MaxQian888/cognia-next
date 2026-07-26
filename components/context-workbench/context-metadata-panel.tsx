"use client"

import type { ReactNode } from "react"

export interface ContextMetadataField {
  label: string
  value: string | number
}

export function ContextMetadataPanel({
  title,
  fields,
  footer,
}: {
  title: string
  fields: ContextMetadataField[]
  /** Actions derived from the metadata above — e.g. "go to the source message". */
  footer?: ReactNode
}) {
  return (
    <section className="h-full overflow-auto p-4" aria-label={title}>
      <h3 className="mb-3 text-sm font-medium">{title}</h3>
      <dl className="space-y-3 text-sm">
        {fields.map((field) => (
          <div key={field.label} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] gap-3">
            <dt className="text-muted-foreground">{field.label}</dt>
            <dd className="min-w-0 break-words text-right font-mono text-xs">{field.value}</dd>
          </div>
        ))}
      </dl>
      {footer ? <div className="mt-4 border-t pt-3">{footer}</div> : null}
    </section>
  )
}
