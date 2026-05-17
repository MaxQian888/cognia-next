import * as React from "react"

// Shared Jest manual mock for `@/components/ui/dropdown-menu`. Content
// always renders so tests can interact with items without driving open
// state.
//   - `DropdownMenuTrigger` honors `asChild`; otherwise renders a real
//     <button>.
//   - `DropdownMenuItem` is a real <button> so click handlers fire.
//   - `DropdownMenuCheckboxItem` / `DropdownMenuRadioItem` capture their
//     checked/value state on data attributes and fire onSelect /
//     onCheckedChange on click.

type DivProps = React.HTMLAttributes<HTMLDivElement> & { children?: React.ReactNode }
type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  asChild?: boolean
  children?: React.ReactNode
}

export function DropdownMenu({ children }: { children?: React.ReactNode }) {
  return <>{children}</>
}

export function DropdownMenuPortal({ children }: { children?: React.ReactNode }) {
  return <>{children}</>
}

export function DropdownMenuTrigger({ children, asChild, ...rest }: ButtonProps) {
  if (asChild) return <>{children}</>
  return (
    <button type="button" data-testid="dropdown-menu-trigger" {...rest}>
      {children}
    </button>
  )
}

export function DropdownMenuContent({ children, ...rest }: DivProps) {
  return (
    <div data-testid="dropdown-menu-content" {...rest}>
      {children}
    </div>
  )
}

export function DropdownMenuGroup({ children, ...rest }: DivProps) {
  return <div {...rest}>{children}</div>
}

export function DropdownMenuLabel({ children, ...rest }: DivProps) {
  return (
    <div data-testid="dropdown-menu-label" {...rest}>
      {children}
    </div>
  )
}

export function DropdownMenuItem({
  children,
  onSelect,
  onClick,
  inset: _inset,
  variant: _variant,
  asChild,
  ...rest
}: ButtonProps & {
  onSelect?: (event: Event) => void
  inset?: boolean
  variant?: string
}) {
  void _inset
  void _variant
  if (asChild) return <>{children}</>
  return (
    <button
      type="button"
      role="menuitem"
      data-testid="dropdown-menu-item"
      onClick={(event) => {
        onClick?.(event)
        if (!event.defaultPrevented) {
          onSelect?.(event.nativeEvent)
        }
      }}
      {...rest}
    >
      {children}
    </button>
  )
}

export function DropdownMenuCheckboxItem({
  children,
  checked,
  onCheckedChange,
  onClick,
  ...rest
}: ButtonProps & {
  checked?: boolean
  onCheckedChange?: (checked: boolean) => void
}) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      data-state={checked ? "checked" : "unchecked"}
      onClick={(event) => {
        onClick?.(event)
        if (!event.defaultPrevented) onCheckedChange?.(!checked)
      }}
      {...rest}
    >
      {children}
    </button>
  )
}

export function DropdownMenuRadioGroup({
  children,
  value,
  onValueChange: _onValueChange,
  ...rest
}: DivProps & {
  value?: string
  onValueChange?: (value: string) => void
}) {
  void _onValueChange
  return (
    <div role="group" data-value={value} {...rest}>
      {children}
    </div>
  )
}

export function DropdownMenuRadioItem({
  children,
  value,
  onClick,
  ...rest
}: ButtonProps & { value: string }) {
  return (
    // eslint-disable-next-line jsx-a11y/role-has-required-aria-props -- mock harness; tests bind aria-checked manually if needed.
    <button type="button" role="menuitemradio" data-value={value} onClick={onClick} {...rest}>
      {children}
    </button>
  )
}

export function DropdownMenuSeparator(props: React.HTMLAttributes<HTMLHRElement>) {
  return <hr data-testid="dropdown-menu-separator" {...props} />
}

export function DropdownMenuShortcut({ children, ...rest }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span data-testid="dropdown-menu-shortcut" {...rest}>
      {children}
    </span>
  )
}

export function DropdownMenuSub({ children }: { children?: React.ReactNode }) {
  return <>{children}</>
}

export function DropdownMenuSubTrigger({ children, asChild, ...rest }: ButtonProps) {
  if (asChild) return <>{children}</>
  return (
    <button type="button" data-testid="dropdown-menu-sub-trigger" {...rest}>
      {children}
    </button>
  )
}

export function DropdownMenuSubContent({ children, ...rest }: DivProps) {
  return (
    <div data-testid="dropdown-menu-sub-content" {...rest}>
      {children}
    </div>
  )
}
