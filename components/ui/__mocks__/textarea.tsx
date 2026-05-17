import * as React from "react"

// Shared Jest manual mock for `@/components/ui/textarea`. Pass-through
// <textarea> with every prop forwarded.

type Props = React.TextareaHTMLAttributes<HTMLTextAreaElement>

export function Textarea(props: Props) {
  return <textarea data-testid="textarea" {...props} />
}
