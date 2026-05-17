import * as React from "react"

// Shared Jest manual mock for `@/components/ui/separator`. Renders an <hr>
// with `data-testid="separator"`. `orientation` and `decorative` are
// accepted and ignored — they only affect ARIA in production.

type Props = React.HTMLAttributes<HTMLHRElement> & {
  orientation?: "horizontal" | "vertical"
  decorative?: boolean
}

export function Separator({ orientation: _orientation, decorative: _decorative, ...rest }: Props) {
  void _orientation
  void _decorative
  return <hr data-testid="separator" {...rest} />
}
