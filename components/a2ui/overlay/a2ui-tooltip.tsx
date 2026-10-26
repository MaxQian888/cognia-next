"use client"

import React, { memo } from "react"
import { A2UITrigger } from "../a2ui-child-renderer"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useA2UIData } from "../a2ui-context"
import type { A2UIComponentProps, A2UIBaseComponent, A2UIStringOrPath } from "@/types/a2ui/schema"

export interface A2UITooltipComponent extends A2UIBaseComponent {
  component: "Tooltip"
  text: A2UIStringOrPath
  children: string[]
  side?: "top" | "right" | "bottom" | "left"
  delayDuration?: number
}

export const A2UITooltip = memo(function A2UITooltip({
  component,
  renderChild,
}: A2UIComponentProps<A2UITooltipComponent>) {
  const { resolveString } = useA2UIData()
  const text = resolveString(component.text)

  return (
    <Tooltip delayDuration={component.delayDuration ?? 200}>
      <TooltipTrigger asChild>
        <A2UITrigger
          componentId={component.children.length === 1 ? component.children[0] : ""}
          renderChild={(id) =>
            component.children.length === 1 ? (
              renderChild(id)
            ) : (
              <>
                {component.children.map((childId) => (
                  <React.Fragment key={childId}>{renderChild(childId)}</React.Fragment>
                ))}
              </>
            )
          }
          className={component.className}
          style={component.style as React.CSSProperties}
        />
      </TooltipTrigger>
      <TooltipContent side={component.side || "top"}>
        <p>{text}</p>
      </TooltipContent>
    </Tooltip>
  )
})
