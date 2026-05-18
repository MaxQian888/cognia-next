import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      // Each variant explicitly re-asserts its foreground with a `dark:`
      // variant. Tailwind's `dark:` selector has higher specificity than the
      // base utility, so any element-tree color leak (browser button
      // defaults, parent text-* utilities applied via cn merge ordering,
      // etc.) cannot win against it in dark mode. The base utility still
      // covers light mode the same way it did before.
      variant: {
        default:
          "bg-primary text-primary-foreground dark:text-primary-foreground [a&]:hover:bg-primary/90",
        secondary:
          "bg-secondary text-secondary-foreground dark:text-secondary-foreground [a&]:hover:bg-secondary/90",
        destructive:
          "bg-destructive text-white dark:text-white focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40 [a&]:hover:bg-destructive/90",
        success:
          "bg-success text-success-foreground dark:text-success-foreground [a&]:hover:bg-success/90",
        warning:
          "bg-warning text-warning-foreground dark:text-warning-foreground [a&]:hover:bg-warning/90",
        outline:
          "border-border text-foreground dark:text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
        ghost: "[a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
        link: "text-primary dark:text-primary underline-offset-4 [a&]:hover:underline",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
