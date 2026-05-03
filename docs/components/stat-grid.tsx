import type { ReactNode } from "react"

type StatProps = {
  label: string
  value: ReactNode
  hint?: string
}

export function Stat({ label, value, hint }: StatProps) {
  return (
    <div className="not-prose rounded-lg border border-fd-border bg-fd-card px-4 py-3">
      <div className="text-xs uppercase tracking-wider text-fd-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-fd-foreground">{value}</div>
      {hint ? <div className="mt-0.5 text-xs text-fd-muted-foreground">{hint}</div> : null}
    </div>
  )
}

type StatGridProps = {
  children: ReactNode
}

export function StatGrid({ children }: StatGridProps) {
  return (
    <div className="not-prose my-6 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
      {children}
    </div>
  )
}
