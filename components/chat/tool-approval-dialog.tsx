"use client"

import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { CodeBlock } from "@/components/ai-elements/code-block"
import type { ApprovalDecision, PendingApproval } from "@/lib/claude/types"
import { ShieldAlertIcon } from "lucide-react"

interface Props {
  approval: PendingApproval | null
  onRespond: (decision: ApprovalDecision) => void | Promise<void>
}

export function ToolApprovalDialog({ approval, onRespond }: Props) {
  const t = useTranslations("chat.toolApproval")
  const open = !!approval
  return (
    <Dialog open={open}>
      <DialogContent
        // The Claude side blocks until we respond — preventing close avoids
        // an "X" button that would orphan the pending Promise.
        showCloseButton={false}
        className="max-w-xl max-w-[calc(100vw-2rem)] sm:max-w-xl"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlertIcon className="size-4 text-amber-500" />
            {approval?.title ?? t("titleFallback", { tool: approval?.toolName ?? "" })}
          </DialogTitle>
          {approval?.description && <DialogDescription>{approval.description}</DialogDescription>}
        </DialogHeader>

        {approval && (
          <div className="space-y-3 text-sm">
            <div>
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t("toolLabel")}
              </div>
              <div className="font-mono text-sm">{approval.displayName ?? approval.toolName}</div>
            </div>
            <div>
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t("inputLabel")}
              </div>
              <CodeBlock code={JSON.stringify(approval.input, null, 2)} language="json" />
            </div>
            {approval.decisionReason && (
              <p className="text-xs text-muted-foreground">{approval.decisionReason}</p>
            )}
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="ghost" onClick={() => void onRespond("deny")}>
            {t("deny")}
          </Button>
          <Button variant="secondary" onClick={() => void onRespond("allow_always")}>
            {t("allowAlways")}
          </Button>
          <Button onClick={() => void onRespond("allow")}>{t("allowOnce")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
