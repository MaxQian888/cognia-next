import * as React from "react"

// Shared Jest manual mock for `@/components/ui/tooltip`. Tests opt in by
// calling `jest.mock("@/components/ui/tooltip")` without a factory; Jest then
// resolves this file via the adjacent `__mocks__/` lookup.
//
// Surface is the union of every inline factory previously duplicated across
// the suite. Render rules:
//   - `Tooltip`, `TooltipProvider`, `TooltipTrigger` are transparent.
//   - `TooltipTrigger` honors `asChild` so the trigger child stays the only
//     element receiving props from callers.
//   - `TooltipContent` wraps children in a span carrying
//     `data-testid="tooltip-content"` plus any forwarded props, so tests that
//     need to assert tooltip wiring can query by test id while tests that
//     don't care simply see the inline text.

type ChildrenProps = { children?: React.ReactNode }
type TriggerProps = ChildrenProps & {
  asChild?: boolean
  [key: string]: unknown
}
type ContentProps = ChildrenProps & { [key: string]: unknown }

export function Tooltip({ children }: ChildrenProps) {
  return <>{children}</>
}

export function TooltipProvider({ children }: ChildrenProps) {
  return <>{children}</>
}

export function TooltipTrigger({ children, asChild: _asChild, ...rest }: TriggerProps) {
  void _asChild
  if (rest && Object.keys(rest).length > 0) {
    return <span {...(rest as React.HTMLAttributes<HTMLSpanElement>)}>{children}</span>
  }
  return <>{children}</>
}

export function TooltipContent({ children, ...rest }: ContentProps) {
  return (
    <span data-testid="tooltip-content" {...(rest as React.HTMLAttributes<HTMLSpanElement>)}>
      {children}
    </span>
  )
}
