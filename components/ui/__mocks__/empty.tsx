import * as React from "react"

// Shared Jest manual mock for `@/components/ui/empty`. Every export is a
// transparent <div> that forwards props. `Empty` itself defaults to
// `data-testid="empty"` (the most common variant) so tests can query by the
// stable id; callers supplying their own `data-testid` win via the spread.

type Props = React.HTMLAttributes<HTMLDivElement> & { children?: React.ReactNode }

export function Empty({ children, ...rest }: Props) {
  return (
    <div data-testid="empty" {...rest}>
      {children}
    </div>
  )
}

export function EmptyHeader({ children, ...rest }: Props) {
  return <div {...rest}>{children}</div>
}

export function EmptyMedia({ children, ...rest }: Props) {
  return <div {...rest}>{children}</div>
}

export function EmptyTitle({ children, ...rest }: Props) {
  return <div {...rest}>{children}</div>
}

export function EmptyDescription({ children, ...rest }: Props) {
  return <div {...rest}>{children}</div>
}

export function EmptyContent({ children, ...rest }: Props) {
  return <div {...rest}>{children}</div>
}
