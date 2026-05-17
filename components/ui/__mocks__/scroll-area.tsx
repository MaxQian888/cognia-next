import * as React from "react"

// Shared Jest manual mock for `@/components/ui/scroll-area`. Renders a div
// that spreads every prop forwarded by callers — this preserves `className`,
// `data-*`, and other attributes that real tests assert on. The constant
// `data-testid="scroll-area"` mirrors the most-used variant; tests that
// supply their own `data-testid` via props win because the spread happens
// after the default.

type Props = React.HTMLAttributes<HTMLDivElement> & { children?: React.ReactNode }

export function ScrollArea({ children, ...rest }: Props) {
  return (
    <div data-testid="scroll-area" {...rest}>
      {children}
    </div>
  )
}

export function ScrollBar(props: React.HTMLAttributes<HTMLDivElement>) {
  return <div {...props} />
}
