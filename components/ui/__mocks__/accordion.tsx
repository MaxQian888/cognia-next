import * as React from "react"

// Shared Jest manual mock for `@/components/ui/accordion`.
//   - `Accordion` is a transparent wrapper; we capture `value` /
//     `defaultValue` / `onValueChange` so tests that drive the accordion
//     programmatically (or just want to assert the current value via
//     `data-value`) can.
//   - `AccordionTrigger` renders a real <button> so click handlers fire.
//   - `AccordionContent` always renders its children (matches the
//     dominant inline factory shape).

type DivProps = React.HTMLAttributes<HTMLDivElement> & { children?: React.ReactNode }
type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  asChild?: boolean
  children?: React.ReactNode
}

export function Accordion({
  children,
  value,
  defaultValue,
  onValueChange: _onValueChange,
  type: _type,
  collapsible: _collapsible,
  ...rest
}: DivProps & {
  value?: string | string[]
  defaultValue?: string | string[]
  onValueChange?: (value: string | string[]) => void
  type?: "single" | "multiple"
  collapsible?: boolean
}) {
  void _onValueChange
  void _type
  void _collapsible
  const resolved = value ?? defaultValue
  const dataValue = Array.isArray(resolved) ? resolved.join(",") : resolved
  return (
    <div data-testid="accordion" data-value={dataValue} {...rest}>
      {children}
    </div>
  )
}

export function AccordionItem({ children, value, ...rest }: DivProps & { value?: string }) {
  return (
    <div data-testid="accordion-item" data-value={value} {...rest}>
      {children}
    </div>
  )
}

export function AccordionTrigger({ children, asChild, ...rest }: ButtonProps) {
  if (asChild) {
    return <>{children}</>
  }
  return (
    <button type="button" data-testid="accordion-trigger" {...rest}>
      {children}
    </button>
  )
}

export function AccordionContent({ children, ...rest }: DivProps) {
  return (
    <div data-testid="accordion-content" {...rest}>
      {children}
    </div>
  )
}
