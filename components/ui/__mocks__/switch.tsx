import * as React from "react"

// Shared Jest manual mock for `@/components/ui/switch`. The real Radix
// Switch is rendered as a <button role="switch">, but for testing we
// model it as an <input type="checkbox"> so userEvent.click toggles
// state and `checked` is queryable via `input.checked`. The
// `onCheckedChange` callback is mapped onto the synthetic input's
// `onChange`.

type Props = Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange" | "type"> & {
  checked?: boolean
  defaultChecked?: boolean
  onCheckedChange?: (checked: boolean) => void
}

export function Switch({ checked, defaultChecked, onCheckedChange, ...rest }: Props) {
  return (
    <input
      type="checkbox"
      role="switch"
      data-testid="switch"
      checked={checked}
      defaultChecked={defaultChecked}
      onChange={(event) => onCheckedChange?.(event.currentTarget.checked)}
      {...rest}
    />
  )
}
