import * as React from "react"

// Shared Jest manual mock for `@/components/ui/alert`. Three transparent
// <div>s with stable data-testids. `variant` is accepted and ignored.

type AlertProps = React.HTMLAttributes<HTMLDivElement> & {
  variant?: string
  children?: React.ReactNode
}
type SimpleProps = React.HTMLAttributes<HTMLDivElement> & { children?: React.ReactNode }

export function Alert({ variant: _variant, children, ...rest }: AlertProps) {
  void _variant
  return (
    <div role="alert" data-testid="alert" {...rest}>
      {children}
    </div>
  )
}

export function AlertTitle({ children, ...rest }: SimpleProps) {
  return (
    <div data-testid="alert-title" {...rest}>
      {children}
    </div>
  )
}

export function AlertDescription({ children, ...rest }: SimpleProps) {
  return (
    <div data-testid="alert-description" {...rest}>
      {children}
    </div>
  )
}
