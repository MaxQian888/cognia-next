import * as React from "react"

// Shared Jest manual mock for `@/components/ui/button`.
//   - `Button` renders a real <button type="button"> by default so clicks
//     fire under JSDOM. Honors `asChild` by transparently forwarding to the
//     child so wrappers like `<Button asChild><Link/></Button>` keep working.
//   - `buttonVariants` is a stub that returns a deterministic class string;
//     callers usually pass it through to `cn()` and don't assert on the value.
//     Tests that DO assert on `buttonVariants` invocations should keep their
//     own inline mock with `jest.fn()`.

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  asChild?: boolean
  variant?: string
  size?: string
  children?: React.ReactNode
}

export function Button({
  asChild,
  variant: _variant,
  size: _size,
  children,
  type,
  ...rest
}: ButtonProps) {
  void _variant
  void _size
  if (asChild) {
    return <>{children}</>
  }
  return (
    <button type={type ?? "button"} {...rest}>
      {children}
    </button>
  )
}

export function buttonVariants(_options?: {
  variant?: string
  size?: string
  className?: string
}): string {
  void _options
  return "button-stub"
}
