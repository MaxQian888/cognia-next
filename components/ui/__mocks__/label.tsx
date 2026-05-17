import * as React from "react"

// Shared Jest manual mock for `@/components/ui/label`. Pass-through <label>
// that forwards every prop (htmlFor / className / data-*).

type Props = React.LabelHTMLAttributes<HTMLLabelElement> & { children?: React.ReactNode }

export function Label({ children, ...rest }: Props) {
  return <label {...rest}>{children}</label>
}
