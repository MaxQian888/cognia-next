import * as React from "react"

// Shared Jest manual mock for `@/components/ui/slider`. The real Radix
// Slider is keyboard-driven and complex; here we stub it as a div carrying
// `data-value` (the first thumb value) plus a hidden range <input> so tests
// that need to fire `change` events still can. `onValueChange` is invoked
// with `[number]` to match the production contract.

type Props = Omit<React.HTMLAttributes<HTMLDivElement>, "defaultValue"> & {
  value?: number[]
  defaultValue?: number[]
  min?: number
  max?: number
  step?: number
  disabled?: boolean
  onValueChange?: (value: number[]) => void
}

export function Slider({
  value,
  defaultValue,
  min = 0,
  max = 100,
  step = 1,
  disabled,
  onValueChange,
  ...rest
}: Props) {
  const resolved = value?.[0] ?? defaultValue?.[0] ?? min
  return (
    <div data-testid="slider" data-value={resolved} {...rest}>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={resolved}
        disabled={disabled}
        onChange={(event) => onValueChange?.([Number(event.currentTarget.value)])}
        aria-label="slider"
      />
    </div>
  )
}
