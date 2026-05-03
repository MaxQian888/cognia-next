import type { ReactNode } from "react"

type Variant = "stable" | "beta" | "experimental" | "deprecated" | "internal" | "planned"

type Props = {
  variant?: Variant
  children?: ReactNode
}

const styles: Record<Variant, { label: string; className: string; dot: string }> = {
  stable: {
    label: "Stable",
    className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    dot: "bg-emerald-500",
  },
  beta: {
    label: "Beta",
    className: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    dot: "bg-amber-500",
  },
  experimental: {
    label: "Experimental",
    className: "border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-700 dark:text-fuchsia-300",
    dot: "bg-fuchsia-500",
  },
  deprecated: {
    label: "Deprecated",
    className: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300",
    dot: "bg-red-500",
  },
  internal: {
    label: "Internal",
    className: "border-slate-500/40 bg-slate-500/10 text-slate-700 dark:text-slate-300",
    dot: "bg-slate-500",
  },
  planned: {
    label: "Planned",
    className: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300",
    dot: "bg-sky-500",
  },
}

export function Status({ variant = "stable", children }: Props) {
  const s = styles[variant] ?? styles.stable
  return (
    <span
      className={`not-prose inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium align-middle ${s.className}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} aria-hidden="true" />
      {children ?? s.label}
    </span>
  )
}
