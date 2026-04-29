"use client"

/**
 * Stub A2UI template preview. Cognia ships a richer renderer that walks
 * the a2ui component tree; cognia-next has no a2ui runtime yet, so this
 * shows a plain JSON dump as a placeholder. Custom-mode editor accepts
 * `template` as `unknown`-ish and only shows it when set.
 */

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useTranslations } from "next-intl"

interface Props {
  template?: unknown
  showPreview?: boolean
  onTogglePreview?: () => void
  className?: string
}

export function A2UITemplatePreview({ template }: Props) {
  const t = useTranslations("agentMode")

  if (!template) {
    return (
      <div className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
        {t("noTemplateSelected") || "No template selected"}
      </div>
    )
  }

  return (
    <Card className="border-dashed">
      <CardHeader className="pb-2">
        <CardTitle className="text-xs uppercase tracking-wide text-muted-foreground">
          A2UI Template Preview
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ScrollArea className="max-h-48">
          <pre className="font-mono text-[11px] leading-snug">
            {JSON.stringify(template, null, 2)}
          </pre>
        </ScrollArea>
      </CardContent>
    </Card>
  )
}

export default A2UITemplatePreview
