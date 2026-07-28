import * as React from "react"

// Shared Jest manual mock for `@/components/ui/popover`. Renders content
// unconditionally (matches the dominant inline-factory shape — tests
// typically render the trigger + content together and don't gate on open).
// The `open` prop is mirrored as `data-state` on the root for opt-in
// inspection, and `modal` as `data-modal` (it changes whether Radix marks the
// rest of the app `aria-hidden`, which some surfaces depend on).

type DivProps = React.HTMLAttributes<HTMLDivElement> & { children?: React.ReactNode }
type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  asChild?: boolean
  children?: React.ReactNode
}

export function Popover({
  children,
  open,
  defaultOpen,
  modal,
  onOpenChange: _onOpenChange,
  ...rest
}: DivProps & {
  open?: boolean
  defaultOpen?: boolean
  modal?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  void _onOpenChange
  const isOpen = open ?? defaultOpen
  return (
    <div
      data-testid="popover"
      data-state={isOpen ? "open" : isOpen === false ? "closed" : undefined}
      data-modal={modal === undefined ? undefined : String(modal)}
      {...rest}
    >
      {children}
    </div>
  )
}

export function PopoverTrigger({ children, asChild, ...rest }: ButtonProps) {
  if (asChild) return <>{children}</>
  return (
    <button type="button" data-testid="popover-trigger" {...rest}>
      {children}
    </button>
  )
}

export function PopoverContent({ children, ...rest }: DivProps) {
  return (
    <div data-testid="popover-content" {...rest}>
      {children}
    </div>
  )
}

export function PopoverAnchor({ children, ...rest }: DivProps) {
  return <div {...rest}>{children}</div>
}

export function PopoverHeader({ children, ...rest }: DivProps) {
  return (
    <div data-testid="popover-header" {...rest}>
      {children}
    </div>
  )
}

export function PopoverTitle({ children, ...rest }: DivProps) {
  return (
    <div data-testid="popover-title" {...rest}>
      {children}
    </div>
  )
}

export function PopoverDescription({ children, ...rest }: DivProps) {
  return (
    <div data-testid="popover-description" {...rest}>
      {children}
    </div>
  )
}
