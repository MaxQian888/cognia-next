import * as React from "react"

// Shared Jest manual mock for `@/components/ui/skeleton`. Renders a
// transparent <div data-testid="skeleton"> with all props forwarded.

type Props = React.HTMLAttributes<HTMLDivElement>

export function Skeleton(props: Props) {
  return <div data-testid="skeleton" {...props} />
}
