"use client"

/** Raw JSON lens over one item of a node's output. */
export function DataJsonView({ item }: { item: unknown }) {
  return (
    <pre
      data-testid="data-json-view"
      className="whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-xs font-mono leading-relaxed break-all"
    >
      {safeStringify(item)}
    </pre>
  )
}

function safeStringify(value: unknown): string {
  if (value === undefined) return "undefined"
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
