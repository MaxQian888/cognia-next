import * as React from "react"
import { ChevronDownIcon } from "lucide-react"
import { Accordion as AccordionPrimitive } from "radix-ui"

import { cn } from "./cn"

/**
 * Stacked disclosure list.
 *
 * The body's open/close has to be a real CSS `@keyframes` animation, not a
 * transition and not a JS one: Radix's `Presence` keeps exiting content mounted
 * only while `getComputedStyle(node).animationName !== "none"`, so anything
 * else is torn out of the DOM before it can play. `animate-accordion-up` /
 * `animate-accordion-down` are those keyframes, published by `tw-animate-css`
 * at the app layer — the same dependency `select`, `tooltip`, `popover`,
 * `dropdown-menu`, `context-menu`, `hover-card` and `sheet` in this package
 * already carry. Keeping it here is what preserves Radix's `hidden` semantics:
 * a collapsed region leaves the accessibility tree entirely rather than
 * lingering as an empty labelled landmark.
 */
function Accordion({ ...props }: React.ComponentProps<typeof AccordionPrimitive.Root>) {
  return <AccordionPrimitive.Root data-slot="accordion" {...props} />
}

function AccordionItem({
  className,
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Item>) {
  return (
    <AccordionPrimitive.Item
      data-slot="accordion-item"
      className={cn("border-b last:border-b-0", className)}
      {...props}
    />
  )
}

function AccordionTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Trigger>) {
  return (
    <AccordionPrimitive.Header className="flex">
      <AccordionPrimitive.Trigger
        data-slot="accordion-trigger"
        className={cn(
          "flex flex-1 items-start justify-between gap-4 rounded-md py-4 text-left text-sm font-medium transition-all outline-none hover:underline focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 [&[data-state=open]>svg]:rotate-180",
          className
        )}
        {...props}
      >
        {children}
        <ChevronDownIcon className="pointer-events-none size-4 shrink-0 translate-y-0.5 text-muted-foreground transition-transform duration-200" />
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  )
}

/**
 * The caller's `className` lands on the inner padding div, not on the animated
 * element: the keyframes interpolate that element's height under a clip, so
 * padding or a border applied there would be sheared off mid-animation instead
 * of growing with it.
 */
function AccordionContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Content>) {
  return (
    <AccordionPrimitive.Content
      data-slot="accordion-content"
      className="overflow-hidden text-sm data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down"
      {...props}
    >
      <div className={cn("pt-0 pb-4", className)}>{children}</div>
    </AccordionPrimitive.Content>
  )
}

export { Accordion, AccordionItem, AccordionTrigger, AccordionContent }
