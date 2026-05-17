import * as React from "react"

// Shared Jest manual mock for `@/components/ui/select`.
//   - `Select` is a controlled-ish wrapper that bridges `value` and
//     `onValueChange` to children via context. Content always renders so
//     tests can interact with `SelectItem`s without driving open state.
//   - `SelectTrigger` is a real <button>.
//   - `SelectValue` displays the current value or the supplied placeholder.
//   - `SelectItem` is a <div role="option" data-value="…"> that fires
//     `onValueChange(value)` on click, matching how most inline factories
//     pretend the popup item works.

type DivProps = React.HTMLAttributes<HTMLDivElement> & { children?: React.ReactNode }
type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  asChild?: boolean
  children?: React.ReactNode
}

const SelectContext = React.createContext<{
  value?: string
  setValue: (next: string) => void
  disabled?: boolean
}>({ value: undefined, setValue: () => {} })

export function Select({
  children,
  value,
  defaultValue,
  onValueChange,
  disabled,
}: {
  children?: React.ReactNode
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  disabled?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const [internal, setInternal] = React.useState<string | undefined>(defaultValue)
  const current = value ?? internal
  const setValue = React.useCallback(
    (next: string) => {
      if (value === undefined) setInternal(next)
      onValueChange?.(next)
    },
    [onValueChange, value]
  )
  return (
    <SelectContext.Provider value={{ value: current, setValue, disabled }}>
      <div data-testid="select" data-value={current}>
        {children}
      </div>
    </SelectContext.Provider>
  )
}

export function SelectGroup({ children, ...rest }: DivProps) {
  return <div {...rest}>{children}</div>
}

export function SelectTrigger({ children, asChild, ...rest }: ButtonProps) {
  if (asChild) return <>{children}</>
  return (
    <button type="button" data-testid="select-trigger" {...rest}>
      {children}
    </button>
  )
}

export function SelectValue({
  placeholder,
  children,
  ...rest
}: React.HTMLAttributes<HTMLSpanElement> & {
  placeholder?: React.ReactNode
  children?: React.ReactNode
}) {
  const ctx = React.useContext(SelectContext)
  return (
    <span data-testid="select-value" data-value={ctx.value} {...rest}>
      {children ?? ctx.value ?? placeholder}
    </span>
  )
}

export function SelectContent({ children, ...rest }: DivProps) {
  return (
    <div role="listbox" data-testid="select-content" {...rest}>
      {children}
    </div>
  )
}

export function SelectLabel({ children, ...rest }: DivProps) {
  return (
    <div data-testid="select-label" {...rest}>
      {children}
    </div>
  )
}

export function SelectItem({
  children,
  value,
  disabled,
  onClick,
  ...rest
}: React.HTMLAttributes<HTMLDivElement> & {
  value: string
  disabled?: boolean
  children?: React.ReactNode
}) {
  const ctx = React.useContext(SelectContext)
  const isSelected = ctx.value === value
  const isDisabled = disabled ?? ctx.disabled ?? false
  const handleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    onClick?.(event)
    if (!event.defaultPrevented && !isDisabled) ctx.setValue(value)
  }
  return (
    <div
      role="option"
      aria-selected={isSelected}
      aria-disabled={isDisabled || undefined}
      data-value={value}
      data-state={isSelected ? "checked" : "unchecked"}
      onClick={handleClick}
      {...rest}
    >
      {children}
    </div>
  )
}

export function SelectSeparator(props: React.HTMLAttributes<HTMLHRElement>) {
  return <hr {...props} />
}

export function SelectScrollUpButton(props: React.HTMLAttributes<HTMLDivElement>) {
  return <div {...props} />
}

export function SelectScrollDownButton(props: React.HTMLAttributes<HTMLDivElement>) {
  return <div {...props} />
}
