"use client"

import { cn } from "@/lib/utils"
import { resolveStringOrPath } from "@/lib/a2ui/data-model"
import type { A2UIComponentProps, A2UIMockupFrameComponent } from "@/types/a2ui/schema"

function getFrameClass(frameStyle: A2UIMockupFrameComponent["frameStyle"]) {
  switch (frameStyle) {
    case "mobile":
      return "mx-auto max-w-sm rounded-[2rem] border-8 border-foreground/10 bg-background shadow-xl"
    case "desktop":
      return "rounded-2xl border border-border/70 bg-background shadow-lg"
    case "browser":
    default:
      return "rounded-2xl border border-border/70 bg-background shadow-lg"
  }
}

export function A2UIMockupFrame({
  component,
  dataModel,
  renderChild,
}: A2UIComponentProps<A2UIMockupFrameComponent>) {
  const title = resolveStringOrPath(component.title ?? "", dataModel, "")
  const caption = resolveStringOrPath(component.caption ?? "", dataModel, "")
  const frameStyle = component.frameStyle || "browser"

  return (
    <div className="space-y-3">
      {title || caption ? (
        <div className="space-y-1">
          {title ? <h4 className="text-sm font-semibold">{title}</h4> : null}
          {caption ? <p className="text-sm text-muted-foreground">{caption}</p> : null}
        </div>
      ) : null}
      <div className={cn("overflow-hidden", getFrameClass(frameStyle))}>
        {frameStyle === "browser" ? (
          <div className="flex items-center gap-2 border-b border-border/60 bg-muted/40 px-4 py-3">
            <span className="h-2.5 w-2.5 rounded-full bg-rose-400" />
            <span className="h-2.5 w-2.5 rounded-full bg-amber-400" />
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-400" />
          </div>
        ) : null}
        {frameStyle === "mobile" ? (
          <div className="mx-auto mt-2 h-1.5 w-16 rounded-full bg-foreground/10" />
        ) : null}
        <div className="space-y-3 p-4">
          {component.children.map((childId) => (
            <div key={childId}>{renderChild(childId)}</div>
          ))}
        </div>
      </div>
    </div>
  )
}
