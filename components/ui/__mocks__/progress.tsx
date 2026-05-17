import * as React from "react"

// Shared Jest manual mock for `@/components/ui/progress`. Renders a
// <div role="progressbar"> with `aria-valuenow` and `data-value` reflecting
// the supplied `value`. Tests can query by role or by `data-testid`.

type Props = React.HTMLAttributes<HTMLDivElement> & {
  value?: number | null
  max?: number
}

export function Progress({ value, max, ...rest }: Props) {
  const resolved = typeof value === "number" ? value : 0
  return (
    <div
      role="progressbar"
      data-testid="progress"
      data-value={resolved}
      aria-valuenow={resolved}
      aria-valuemin={0}
      aria-valuemax={max ?? 100}
      {...rest}
    />
  )
}
