import * as React from "react"

// Shared Jest manual mock for `@/components/ui/checkbox`. Renders a real
// <input type="checkbox"> and maps `onCheckedChange` onto `onChange`.
// The `checked` prop can be `boolean | "indeterminate"`; for indeterminate
// we set the DOM `indeterminate` flag via a ref effect so axe / RTL still
// see a checked={false} input but JSDOM exposes `indeterminate=true`.

type Props = Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange" | "type" | "checked"> & {
  checked?: boolean | "indeterminate"
  defaultChecked?: boolean
  onCheckedChange?: (checked: boolean | "indeterminate") => void
}

export function Checkbox({ checked, defaultChecked, onCheckedChange, ...rest }: Props) {
  const ref = React.useRef<HTMLInputElement | null>(null)
  React.useEffect(() => {
    if (ref.current) {
      ref.current.indeterminate = checked === "indeterminate"
    }
  }, [checked])
  const isChecked = checked === "indeterminate" ? false : Boolean(checked)
  return (
    <input
      ref={ref}
      type="checkbox"
      data-testid="checkbox"
      checked={isChecked}
      defaultChecked={defaultChecked}
      onChange={(event) => onCheckedChange?.(event.currentTarget.checked)}
      {...rest}
    />
  )
}
