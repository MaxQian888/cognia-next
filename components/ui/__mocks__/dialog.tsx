import * as React from "react"

// Shared Jest manual mock for `@/components/ui/dialog`.
//   - `Dialog` renders its children only when `open === true`, matching the
//     dominant inline factory pattern (`open ? <div…/> : null`). The
//     `onOpenChange` callback is bridged to children via context so
//     `DialogClose` and `DialogTrigger` can fire it.
//   - Compound parts are transparent <div>s with stable data-testids.
//   - `DialogTrigger` honors `asChild`; without it, renders a real
//     <button> so clicks fire under JSDOM.

type DivProps = React.HTMLAttributes<HTMLDivElement> & { children?: React.ReactNode }
type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  asChild?: boolean
  children?: React.ReactNode
}

const DialogContext = React.createContext<{ onOpenChange?: (open: boolean) => void }>({})

export function Dialog({
  children,
  open,
  defaultOpen,
  onOpenChange,
}: {
  children?: React.ReactNode
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const isOpen = open ?? defaultOpen ?? false
  if (!isOpen) return null
  return (
    <DialogContext.Provider value={{ onOpenChange }}>
      <div role="dialog" data-testid="dialog">
        {children}
      </div>
    </DialogContext.Provider>
  )
}

export function DialogPortal({ children }: { children?: React.ReactNode }) {
  return <>{children}</>
}

export function DialogOverlay({ children, ...rest }: DivProps) {
  return (
    <div data-testid="dialog-overlay" {...rest}>
      {children}
    </div>
  )
}

export function DialogContent({ children, ...rest }: DivProps) {
  return (
    <div data-testid="dialog-content" {...rest}>
      {children}
    </div>
  )
}

export function DialogHeader({ children, ...rest }: DivProps) {
  return (
    <div data-testid="dialog-header" {...rest}>
      {children}
    </div>
  )
}

export function DialogFooter({ children, ...rest }: DivProps) {
  return (
    <div data-testid="dialog-footer" {...rest}>
      {children}
    </div>
  )
}

export function DialogTitle({ children, ...rest }: DivProps) {
  return (
    <h2 data-testid="dialog-title" {...(rest as React.HTMLAttributes<HTMLHeadingElement>)}>
      {children}
    </h2>
  )
}

export function DialogDescription({ children, ...rest }: DivProps) {
  return (
    <p data-testid="dialog-description" {...(rest as React.HTMLAttributes<HTMLParagraphElement>)}>
      {children}
    </p>
  )
}

export function DialogTrigger({ children, asChild, onClick, ...rest }: ButtonProps) {
  const ctx = React.useContext(DialogContext)
  if (asChild) return <>{children}</>
  return (
    <button
      type="button"
      data-testid="dialog-trigger"
      onClick={(event) => {
        onClick?.(event)
        if (!event.defaultPrevented) ctx.onOpenChange?.(true)
      }}
      {...rest}
    >
      {children}
    </button>
  )
}

export function DialogClose({ children, asChild, onClick, ...rest }: ButtonProps) {
  const ctx = React.useContext(DialogContext)
  if (asChild) return <>{children}</>
  return (
    <button
      type="button"
      data-testid="dialog-close"
      onClick={(event) => {
        onClick?.(event)
        if (!event.defaultPrevented) ctx.onOpenChange?.(false)
      }}
      {...rest}
    >
      {children}
    </button>
  )
}
