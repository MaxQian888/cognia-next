import * as React from "react"

import { cn } from "@/lib/utils"

function Card({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      className={cn(
        "flex flex-col gap-6 rounded-xl border bg-card py-6 text-card-foreground shadow-sm",
        "[[data-settings-panel]_&]:min-w-0 [[data-settings-panel]_&]:gap-4",
        "[[data-settings-panel]_&]:rounded-none [[data-settings-panel]_&]:border-x-0 [[data-settings-panel]_&]:border-t-0",
        "[[data-settings-panel]_&]:border-b [[data-settings-panel]_&]:border-border/60 [[data-settings-panel]_&]:bg-transparent",
        "[[data-settings-panel]_&]:py-5 [[data-settings-panel]_&]:shadow-none [[data-settings-panel]_&]:last:border-b-0",
        className
      )}
      {...props}
    />
  )
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "@container/card-header grid auto-rows-min grid-rows-[auto_auto] items-start gap-2 px-6 has-data-[slot=card-action]:grid-cols-[1fr_auto] [.border-b]:pb-6",
        "[[data-settings-panel]_&]:gap-1.5 [[data-settings-panel]_&]:px-0",
        className
      )}
      {...props}
    />
  )
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn("leading-none font-semibold", className)}
      {...props}
    />
  )
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn("col-start-2 row-span-2 row-start-1 self-start justify-self-end", className)}
      {...props}
    />
  )
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      className={cn(
        "px-6 [[data-settings-panel]_&]:min-w-0 [[data-settings-panel]_&]:px-0",
        className
      )}
      {...props}
    />
  )
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn(
        "flex items-center px-6 [.border-t]:pt-6",
        "[[data-settings-panel]_&]:flex-wrap [[data-settings-panel]_&]:gap-2 [[data-settings-panel]_&]:px-0",
        className
      )}
      {...props}
    />
  )
}

export { Card, CardHeader, CardFooter, CardTitle, CardAction, CardDescription, CardContent }
