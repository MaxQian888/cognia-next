"use client"

export interface ContextMetadataField {
  label: string
  value: string | number
}

export function ContextMetadataPanel({
  title,
  fields,
}: {
  title: string
  fields: ContextMetadataField[]
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
    </section>
  )
}
