/**
 * Cognia compat shim — `ErrorTraceDetails` renders structured error
 * info inside the canvas error boundary. cognia-next ships a slim
 * version using shadcn `Alert` + a collapsible stack frame block.
 */

"use client"

import { useState } from "react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { ChevronDown, AlertCircle } from "lucide-react"
import { cn } from "@/lib/utils"

export interface ErrorTraceDetailsProps {
  error: Error | { message: string; stack?: string } | null
  componentStack?: string | null
  /** Cognia compatibility — label rendered above the component stack. */
  componentStackLabel?: string
  /** Cognia compatibility — label for the copy-to-clipboard button. */
  copyLabel?: string
  className?: string
  title?: string
}

export function ErrorTraceDetails({
  error,
  componentStack,
  className,
  title = "Something went wrong",
}: ErrorTraceDetailsProps) {
  const [open, setOpen] = useState(false)
  if (!error) return null
  const message = "message" in error ? error.message : String(error)
  const stack = "stack" in error ? error.stack : undefined

  return (
    <Alert variant="destructive" className={cn("space-y-2", className)}>
      <AlertCircle className="h-4 w-4" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="space-y-2">
        <p className="text-sm">{message}</p>
        {(stack || componentStack) && (
          <Collapsible open={open} onOpenChange={setOpen}>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs">
                <ChevronDown
                  className={cn("mr-1 h-3 w-3 transition-transform", open && "rotate-180")}
                />
                {open ? "Hide" : "Show"} stack trace
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <pre className="mt-2 max-h-60 overflow-auto rounded bg-muted/40 p-2 text-[11px] font-mono leading-relaxed">
                {stack}
                {componentStack ? `\n\nComponent stack:\n${componentStack}` : ""}
              </pre>
            </CollapsibleContent>
          </Collapsible>
        )}
      </AlertDescription>
    </Alert>
  )
}
