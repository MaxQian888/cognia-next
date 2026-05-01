"use client"

/**
 * A2UI Card Component
 * Maps to shadcn/ui Card
 */

import React, { memo } from "react"
import { cn } from "@/lib/utils"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import type { A2UIComponentProps, A2UICardComponent } from "@/types/a2ui/schema"
import { useA2UIData } from "../a2ui-context"
import { A2UIChildRenderer } from "../a2ui-renderer"

export const A2UICard = memo(function A2UICard({
  component,
  onAction,
}: A2UIComponentProps<A2UICardComponent>) {
  const { resolveString, resolveBoolean } = useA2UIData()

  const title = component.title ? resolveString(component.title, "") : ""
  const description = component.description ? resolveString(component.description, "") : ""
  const image = component.image ? resolveString(component.image, "") : ""
  const isDisabled = component.disabled ? resolveBoolean(component.disabled, false) : false

  const handleClick = () => {
    if (!isDisabled && component.clickAction) {
      onAction(component.clickAction, { title, description })
    }
  }

  const isClickable = !!component.clickAction && !isDisabled

  return (
    <Card
      className={cn(
        isClickable &&
          "cursor-pointer transition-colors hover:bg-accent/50 active:bg-accent/70 touch-manipulation",
        component.className
      )}
      style={component.style as React.CSSProperties}
      onClick={isClickable ? handleClick : undefined}
    >
      {image && (
        <div className="relative aspect-video overflow-hidden rounded-t-lg">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={image} alt={title || "Card image"} className="h-full w-full object-cover" />
        </div>
      )}
      {(title || description) && (
        <CardHeader className="p-4 sm:p-6">
          {title && <CardTitle className="text-base sm:text-lg">{title}</CardTitle>}
          {description && (
            <CardDescription className="text-xs sm:text-sm">{description}</CardDescription>
          )}
        </CardHeader>
      )}
      {component.children && component.children.length > 0 && (
        <CardContent className="px-4 sm:px-6 pb-4 sm:pb-6">
          <A2UIChildRenderer childIds={component.children} />
        </CardContent>
      )}
      {component.footer && component.footer.length > 0 && (
        <CardFooter className="px-4 sm:px-6 pb-4 sm:pb-6">
          <A2UIChildRenderer childIds={component.footer} />
        </CardFooter>
      )}
    </Card>
  )
})
