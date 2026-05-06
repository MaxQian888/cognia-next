"use client"

import React, { memo } from "react"
import { cn } from "@/lib/utils"
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from "@/components/ui/carousel"
import type { A2UIComponentProps, A2UIBaseComponent } from "@/types/a2ui/schema"

export interface A2UICarouselComponent extends A2UIBaseComponent {
  component: "Carousel"
  children: string[]
  showControls?: boolean
  loop?: boolean
}

export const A2UICarousel = memo(function A2UICarousel({
  component,
  renderChild,
}: A2UIComponentProps<A2UICarouselComponent>) {
  return (
    <Carousel
      opts={{ loop: component.loop ?? false }}
      className={cn("w-full", component.className)}
      style={component.style as React.CSSProperties}
    >
      <CarouselContent>
        {component.children.map((childId) => (
          <CarouselItem key={childId}>{renderChild(childId)}</CarouselItem>
        ))}
      </CarouselContent>
      {component.showControls !== false && (
        <>
          <CarouselPrevious />
          <CarouselNext />
        </>
      )}
    </Carousel>
  )
})
