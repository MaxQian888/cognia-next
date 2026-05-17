import * as React from "react"

// Shared Jest manual mock for `@/components/ui/alert-dialog`. Mirrors the
// dialog mock — content rendered only when `open === true`; Cancel/Action
// become real <button>s that fire `onOpenChange(false)` and forward
// `onClick` so tests can assert on the action callback.

type DivProps = React.HTMLAttributes<HTMLDivElement> & { children?: React.ReactNode }
type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  asChild?: boolean
  children?: React.ReactNode
}

const AlertDialogContext = React.createContext<{ onOpenChange?: (open: boolean) => void }>({})

export function AlertDialog({
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
    <AlertDialogContext.Provider value={{ onOpenChange }}>
      <div role="alertdialog" data-testid="alert-dialog">
        {children}
      </div>
    </AlertDialogContext.Provider>
  )
}

export function AlertDialogPortal({ children }: { children?: React.ReactNode }) {
  return <>{children}</>
}

export function AlertDialogOverlay({ children, ...rest }: DivProps) {
  return (
    <div data-testid="alert-dialog-overlay" {...rest}>
      {children}
    </div>
  )
}

export function AlertDialogContent({ children, ...rest }: DivProps) {
  return (
    <div data-testid="alert-dialog-content" {...rest}>
      {children}
    </div>
  )
}

export function AlertDialogHeader({ children, ...rest }: DivProps) {
  return (
    <div data-testid="alert-dialog-header" {...rest}>
      {children}
    </div>
  )
}

export function AlertDialogFooter({ children, ...rest }: DivProps) {
  return (
    <div data-testid="alert-dialog-footer" {...rest}>
      {children}
    </div>
  )
}

export function AlertDialogTitle({ children, ...rest }: DivProps) {
  return (
    <h2 data-testid="alert-dialog-title" {...(rest as React.HTMLAttributes<HTMLHeadingElement>)}>
      {children}
    </h2>
  )
}

export function AlertDialogDescription({ children, ...rest }: DivProps) {
  return (
    <p
      data-testid="alert-dialog-description"
      {...(rest as React.HTMLAttributes<HTMLParagraphElement>)}
    >
      {children}
    </p>
  )
}

export function AlertDialogMedia({ children, ...rest }: DivProps) {
  return (
    <div data-testid="alert-dialog-media" {...rest}>
      {children}
    </div>
  )
}

export function AlertDialogTrigger({ children, asChild, onClick, ...rest }: ButtonProps) {
  const ctx = React.useContext(AlertDialogContext)
  if (asChild) return <>{children}</>
  return (
    <button
      type="button"
      data-testid="alert-dialog-trigger"
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

export function AlertDialogAction({ children, asChild, onClick, ...rest }: ButtonProps) {
  const ctx = React.useContext(AlertDialogContext)
  if (asChild) return <>{children}</>
  return (
    <button
      type="button"
      data-testid="alert-dialog-action"
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

export function AlertDialogCancel({ children, asChild, onClick, ...rest }: ButtonProps) {
  const ctx = React.useContext(AlertDialogContext)
  if (asChild) return <>{children}</>
  return (
    <button
      type="button"
      data-testid="alert-dialog-cancel"
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
