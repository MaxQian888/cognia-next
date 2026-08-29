"use client"

/**
 * A2UI template read-out for the custom-mode editor.
 *
 * What this shows is the template's SPEC, not a live surface, and that is a
 * deliberate limit rather than a missing runtime: cognia-next does ship an A2UI
 * renderer (`components/a2ui/a2ui-renderer.tsx`), but it renders
 * `@/types/a2ui/schema`'s component union inside an A2UI context that supplies
 * a data model and action handlers. A custom-mode template is the protocol-v0.9
 * shape from `@/types/artifact/a2ui`, and a settings form has no session to bind
 * its actions to — so painting one live would need a cross-schema adapter and a
 * fake action sink. The structure, the component tree and the raw spec are what
 * the author can actually check here.
 *
 * Every prop is load-bearing. `showPreview` / `onTogglePreview` were declared
 * and ignored for long enough that the editor's test grew a mock with a toggle
 * button the real component never had; the body is now genuinely collapsible
 * through them, and the editor binds them to the mode's own `previewEnabled`
 * flag so the two controls stay one switch.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { ChevronDownIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"

/**
 * Structural shape this component reads. Kept local and permissive because the
 * editor holds the template as generator output — an absent `components` array
 * must degrade to "0 components", never throw.
 */
interface TemplateShape {
  name?: unknown
  description?: unknown
  components?: unknown
}

interface TreeLine {
  depth: number
  label: string
}

/** Flatten the component tree to `depth`-tagged type names, cycles aside. */
function toTreeLines(node: unknown, depth = 0, out: TreeLine[] = [], seen = new Set<unknown>()) {
  if (!Array.isArray(node)) return out
  for (const child of node) {
    if (typeof child !== "object" || child === null || seen.has(child)) continue
    seen.add(child)
    const record = child as Record<string, unknown>
    const type = record.component ?? record.type
    out.push({ depth, label: typeof type === "string" ? type : "?" })
    toTreeLines(record.children, depth + 1, out, seen)
  }
  return out
}

/**
 * `JSON.stringify` THROWS on a cycle, which took the whole editor down with it —
 * and a generated template is model output, so a self-referencing `children` is
 * exactly the input this has to survive.
 */
function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>()
  try {
    return JSON.stringify(
      value,
      (_key, val) => {
        if (typeof val !== "object" || val === null) return val
        if (seen.has(val)) return "[Circular]"
        seen.add(val)
        return val
      },
      2
    )
  } catch {
    return String(value)
  }
}

function countComponents(template: TemplateShape | undefined): number {
  return Array.isArray(template?.components) ? template.components.length : 0
}

export interface A2UITemplatePreviewProps {
  /** The mode's stored A2UI template, when it has one. */
  template?: unknown
  /** Whether the spec body is expanded. */
  showPreview?: boolean
  /** Toggle the body. Omit to render the card permanently expanded. */
  onTogglePreview?: () => void
  className?: string
}

export function A2UITemplatePreview({
  template,
  showPreview = true,
  onTogglePreview,
  className,
}: A2UITemplatePreviewProps) {
  const t = useTranslations("agentMode")

  const shape: TemplateShape | undefined =
    typeof template === "object" && template !== null ? (template as TemplateShape) : undefined

  const lines = useMemo(() => toTreeLines(shape?.components), [shape])
  const total = countComponents(shape)

  if (!template) {
    return (
      <div
        className={cn(
          "rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground",
          className
        )}
        data-testid="a2ui-template-empty"
      >
        {t("noTemplateSelected")}
      </div>
    )
  }

  // Without a toggle handler the card has no way to collapse, so it stays open
  // rather than rendering a header over nothing.
  const expanded = onTogglePreview ? showPreview : true

  return (
    <Card className={cn("border-dashed", className)} data-testid="a2ui-template-preview">
      {/* `flex` (not just `flex-row`) — CardHeader's base is a grid, and only a
          display utility in the same group overrides it through `cn`. */}
      <CardHeader className="flex items-center justify-between gap-2 pb-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <CardTitle className="text-xs uppercase tracking-wide text-muted-foreground">
            {t("a2uiTemplatePreviewTitle")}
          </CardTitle>
          <Badge variant="outline" className="text-[10px]" data-testid="a2ui-template-count">
            {t("a2uiTemplateComponents", { n: total })}
          </Badge>
        </div>
        {onTogglePreview ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="shrink-0"
            onClick={onTogglePreview}
            aria-expanded={expanded}
            data-testid="a2ui-toggle-preview"
          >
            {expanded ? t("a2uiTemplateHide") : t("a2uiTemplateShow")}
            <ChevronDownIcon
              className={cn("ml-1 size-3.5 transition-transform", expanded && "rotate-180")}
              aria-hidden
            />
          </Button>
        ) : null}
      </CardHeader>
      {expanded ? (
        <CardContent className="space-y-3" data-testid="a2ui-template-body">
          <div className="space-y-0.5">
            <p className="truncate text-sm font-medium">
              {typeof shape?.name === "string" && shape.name
                ? shape.name
                : t("a2uiTemplateUntitled")}
            </p>
            {typeof shape?.description === "string" && shape.description ? (
              <p className="text-xs text-muted-foreground">{shape.description}</p>
            ) : null}
          </div>

          {lines.length > 0 ? (
            <ScrollArea className="max-h-40">
              <ul className="space-y-0.5" data-testid="a2ui-template-tree">
                {lines.map((line, i) => (
                  <li
                    key={`${line.label}-${i}`}
                    className="font-mono text-[11px] leading-snug text-muted-foreground"
                    style={{ paddingInlineStart: line.depth * 12 }}
                  >
                    {line.label}
                  </li>
                ))}
              </ul>
            </ScrollArea>
          ) : null}

          <div className="space-y-1">
            <p className="text-[11px] text-muted-foreground">{t("a2uiTemplateSpecNote")}</p>
            <ScrollArea className="max-h-48">
              <pre className="font-mono text-[11px] leading-snug">{safeStringify(template)}</pre>
            </ScrollArea>
          </div>
        </CardContent>
      ) : null}
    </Card>
  )
}

export default A2UITemplatePreview
