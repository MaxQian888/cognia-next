import * as React from "react"

// Shared Jest manual mock for `@/components/ui/card`. Each export is a
// transparent <div> with a stable data-testid. Tests that supply their own
// `data-testid` via props win because the spread happens after the default.

type Props = React.HTMLAttributes<HTMLDivElement> & { children?: React.ReactNode }

function makeDiv(testId: string) {
  return function CardPart({ children, ...rest }: Props) {
    return (
      <div data-testid={testId} {...rest}>
        {children}
      </div>
    )
  }
}

export const Card = makeDiv("card")
export const CardHeader = makeDiv("card-header")
export const CardTitle = makeDiv("card-title")
export const CardAction = makeDiv("card-action")
export const CardDescription = makeDiv("card-description")
export const CardContent = makeDiv("card-content")
export const CardFooter = makeDiv("card-footer")
