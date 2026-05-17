import * as React from "react"

// Shared Jest manual mock for `@/components/ui/badge`.
//   - `Badge` is a transparent <span> with `data-testid="badge"`. The
//     `variant` prop is accepted and ignored (real component maps it to a
//     class via badgeVariants).
//   - `badgeVariants` returns a deterministic class string. Tests that
//     assert on its return value should keep their inline mock.

type BadgeProps = React.HTMLAttributes<HTMLSpanElement> & {
  variant?: string
  asChild?: boolean
  children?: React.ReactNode
}

export function Badge({ variant: _variant, asChild, children, ...rest }: BadgeProps) {
  void _variant
  if (asChild) {
    return <>{children}</>
  }
  return (
    <span data-testid="badge" {...rest}>
      {children}
    </span>
  )
}

export function badgeVariants(_options?: { variant?: string; className?: string }): string {
  void _options
  return "badge-stub"
}
