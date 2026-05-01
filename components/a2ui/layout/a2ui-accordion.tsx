"use client"

/**
 * A2UI Accordion Component
 * Maps to shadcn/ui Accordion for collapsible content sections
 */

import React, { memo, useRef, useState } from "react"
import { cn } from "@/lib/utils"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import type { A2UIComponentProps, A2UIAccordionComponent } from "@/types/a2ui/schema"
import { A2UIChildRenderer } from "../a2ui-renderer"
import { useA2UIKeyboard } from "@/hooks/a2ui/use-a2ui-keyboard"

export const A2UIAccordion = memo(function A2UIAccordion({
  component,
}: A2UIComponentProps<A2UIAccordionComponent>) {
  const defaultOpenItems = component.items.filter((item) => item.defaultOpen).map((item) => item.id)

  const [focusedIndex, setFocusedIndex] = useState(0)
  const [isFocused, setIsFocused] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useA2UIKeyboard({
    onArrowUp: () => setFocusedIndex((prev) => Math.max(0, prev - 1)),
    onArrowDown: () => setFocusedIndex((prev) => Math.min(component.items.length - 1, prev + 1)),
    onEnter: () => {
      const triggers = containerRef.current?.querySelectorAll("[data-radix-collection-item]")
      if (triggers?.[focusedIndex]) {
        ;(triggers[focusedIndex] as HTMLElement).click()
      }
    },
    enabled: isFocused,
  })

  const focusHandlers = {
    onFocus: () => setIsFocused(true),
    onBlur: () => setIsFocused(false),
  }

  if (component.multiple) {
    return (
      <div ref={containerRef} {...focusHandlers}>
        <Accordion
          type="multiple"
          defaultValue={defaultOpenItems}
          className={cn("w-full", component.className)}
          style={component.style as React.CSSProperties}
        >
          {component.items.map((item) => (
            <AccordionItem key={item.id} value={item.id}>
              <AccordionTrigger>{item.title}</AccordionTrigger>
              <AccordionContent>
                <A2UIChildRenderer childIds={item.children} />
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>
    )
  }

  return (
    <div ref={containerRef} {...focusHandlers}>
      <Accordion
        type="single"
        collapsible={component.collapsible !== false}
        defaultValue={defaultOpenItems[0]}
        className={cn("w-full", component.className)}
        style={component.style as React.CSSProperties}
      >
        {component.items.map((item) => (
          <AccordionItem key={item.id} value={item.id}>
            <AccordionTrigger>{item.title}</AccordionTrigger>
            <AccordionContent>
              <A2UIChildRenderer childIds={item.children} />
            </AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </div>
  )
})
