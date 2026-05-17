import * as React from "react"

// Shared Jest manual mock for `@/components/ui/collapsible`.
//   - `Collapsible` exposes the `open` state via `data-open` so tests can
//     assert visibility without driving Radix internals.
//   - `CollapsibleTrigger` renders a real <button> by default (so click
//     handlers fire under JSDOM) and honors `asChild` by transparently
//     forwarding to the child.
//   - `CollapsibleContent` is a transparent div that always renders, which
//     matches every prior inline factory's behavior.

type ChildrenProps = { children?: React.ReactNode }

export function Collapsible({
  children,
  open,
  onOpenChange: _onOpenChange,
  ...rest
}: ChildrenProps & {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  [key: string]: unknown
}) {
  void _onOpenChange
  return (
    <div data-open={open ? "true" : undefined} {...(rest as React.HTMLAttributes<HTMLDivElement>)}>
      {children}
    </div>
  )
}

export function CollapsibleTrigger({
  children,
  asChild,
  ...rest
}: ChildrenProps & { asChild?: boolean; [key: string]: unknown }) {
  if (asChild) {
    return <>{children}</>
  }
  return (
    <button type="button" {...(rest as React.ButtonHTMLAttributes<HTMLButtonElement>)}>
      {children}
    </button>
  )
}

export function CollapsibleContent({
  children,
  ...rest
}: ChildrenProps & { [key: string]: unknown }) {
  return <div {...(rest as React.HTMLAttributes<HTMLDivElement>)}>{children}</div>
}
