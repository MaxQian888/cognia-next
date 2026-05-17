import * as React from "react"

// Shared Jest manual mock for `@/components/ui/input`. Renders a real
// <input> with every prop forwarded so tests can drive value / onChange /
// onKeyDown / disabled / placeholder / data-* the same way the production
// component does. Defaults to `data-testid="input"` but a caller-supplied
// `data-testid` wins via the spread order.

type Props = React.InputHTMLAttributes<HTMLInputElement>

export function Input(props: Props) {
  return <input data-testid="input" {...props} />
}
