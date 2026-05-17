import * as React from "react"

// Shared Jest manual mock for `@/components/ui/radio-group`. Models the
// real Radix API:
//   - `RadioGroup` is a controlled-ish wrapper; we expose `data-value` for
//     inspection and bridge `value` / `onValueChange` to children via
//     context so each `RadioGroupItem` can mark itself active.
//   - `RadioGroupItem` is a <button role="radio"> that fires onValueChange
//     when clicked (matches the keyboard-less stub most tests need).

type DivProps = React.HTMLAttributes<HTMLDivElement> & { children?: React.ReactNode }

const RadioGroupContext = React.createContext<{
  value?: string
  setValue: (next: string) => void
  disabled?: boolean
}>({ value: undefined, setValue: () => {} })

export function RadioGroup({
  children,
  value,
  defaultValue,
  onValueChange,
  disabled,
  ...rest
}: DivProps & {
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  disabled?: boolean
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
    <RadioGroupContext.Provider value={{ value: current, setValue, disabled }}>
      <div role="radiogroup" data-testid="radio-group" data-value={current} {...rest}>
        {children}
      </div>
    </RadioGroupContext.Provider>
  )
}

export function RadioGroupItem({
  value,
  disabled,
  children,
  onClick,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  value: string
  children?: React.ReactNode
}) {
  const ctx = React.useContext(RadioGroupContext)
  const isChecked = ctx.value === value
  const isDisabled = disabled ?? ctx.disabled ?? false
  const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    onClick?.(event)
    if (!event.defaultPrevented && !isDisabled) ctx.setValue(value)
  }
  return (
    <button
      type="button"
      role="radio"
      aria-checked={isChecked}
      data-state={isChecked ? "checked" : "unchecked"}
      data-value={value}
      disabled={isDisabled}
      onClick={handleClick}
      {...rest}
    >
      {children}
    </button>
  )
}
