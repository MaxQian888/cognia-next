import * as React from "react"

// Shared Jest manual mock for `@/components/ui/tabs`.
//   - `Tabs` accepts `value` / `defaultValue` / `onValueChange` and exposes
//     the current value via `data-value` for inspection.
//   - `TabsList` is a transparent <div role="tablist">.
//   - `TabsTrigger` is a real <button> with `role="tab"`; clicking it fires
//     the captured `onValueChange` from the nearest Tabs ancestor via a
//     small context bridge so suite-level drag tests work without rebinding.
//   - `TabsContent` always renders its children (matches every inline
//     factory) and tags itself with `data-state` for opt-in assertions.
//   - `tabsListVariants` returns a deterministic class string.

type DivProps = React.HTMLAttributes<HTMLDivElement> & { children?: React.ReactNode }
type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { children?: React.ReactNode }

const TabsContext = React.createContext<{
  value?: string
  setValue: (next: string) => void
}>({ value: undefined, setValue: () => {} })

export function Tabs({
  children,
  value,
  defaultValue,
  onValueChange,
  ...rest
}: DivProps & {
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
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
    <TabsContext.Provider value={{ value: current, setValue }}>
      <div data-testid="tabs" data-value={current} {...rest}>
        {children}
      </div>
    </TabsContext.Provider>
  )
}

export function TabsList({ children, ...rest }: DivProps) {
  return (
    <div role="tablist" data-testid="tabs-list" {...rest}>
      {children}
    </div>
  )
}

export function TabsTrigger({
  children,
  value,
  onClick,
  ...rest
}: ButtonProps & { value: string }) {
  const ctx = React.useContext(TabsContext)
  const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    onClick?.(event)
    if (!event.defaultPrevented) ctx.setValue(value)
  }
  return (
    <button
      type="button"
      role="tab"
      data-value={value}
      data-state={ctx.value === value ? "active" : "inactive"}
      onClick={handleClick}
      {...rest}
    >
      {children}
    </button>
  )
}

export function TabsContent({ children, value, ...rest }: DivProps & { value: string }) {
  const ctx = React.useContext(TabsContext)
  return (
    <div
      role="tabpanel"
      data-value={value}
      data-state={ctx.value === value ? "active" : "inactive"}
      {...rest}
    >
      {children}
    </div>
  )
}

export function tabsListVariants(_options?: { className?: string }): string {
  void _options
  return "tabs-list-stub"
}
