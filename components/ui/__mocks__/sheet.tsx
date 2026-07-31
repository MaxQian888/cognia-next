import * as React from "react"

// Shared Jest manual mock for `@/components/ui/sheet`. Same shape as the
// dialog mock — content gated on `open === true`.

type DivProps = React.HTMLAttributes<HTMLDivElement> & { children?: React.ReactNode }
type SheetContentProps = DivProps & { showCloseButton?: boolean }
type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  asChild?: boolean
  children?: React.ReactNode
}

const SheetContext = React.createContext<{ onOpenChange?: (open: boolean) => void }>({})

export function Sheet({
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
    <SheetContext.Provider value={{ onOpenChange }}>
      <div role="dialog" data-testid="sheet">
        {children}
      </div>
    </SheetContext.Provider>
  )
}

export function SheetContent({ children, showCloseButton: _showCloseButton, ...rest }: SheetContentProps) {
  return (
    <div data-testid="sheet-content" {...rest}>
      {children}
    </div>
  )
}

export function SheetHeader({ children, ...rest }: DivProps) {
  return (
    <div data-testid="sheet-header" {...rest}>
      {children}
    </div>
  )
}

export function SheetFooter({ children, ...rest }: DivProps) {
  return (
    <div data-testid="sheet-footer" {...rest}>
      {children}
    </div>
  )
}

export function SheetTitle({ children, ...rest }: DivProps) {
  return (
    <h2 data-testid="sheet-title" {...(rest as React.HTMLAttributes<HTMLHeadingElement>)}>
      {children}
    </h2>
  )
}

export function SheetDescription({ children, ...rest }: DivProps) {
  return (
    <p data-testid="sheet-description" {...(rest as React.HTMLAttributes<HTMLParagraphElement>)}>
      {children}
    </p>
  )
}

export function SheetTrigger({ children, asChild, onClick, ...rest }: ButtonProps) {
  const ctx = React.useContext(SheetContext)
  if (asChild) return <>{children}</>
  return (
    <button
      type="button"
      data-testid="sheet-trigger"
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

export function SheetClose({ children, asChild, onClick, ...rest }: ButtonProps) {
  const ctx = React.useContext(SheetContext)
  if (asChild) return <>{children}</>
  return (
    <button
      type="button"
      data-testid="sheet-close"
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
