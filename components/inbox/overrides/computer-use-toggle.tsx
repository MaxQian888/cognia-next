"use client"

/**
 * Header-level toggle that opens / closes Computer-Use on the current
 * conversation. Backed by `ConversationOverrideRow.allowComputerUse`.
 *
 * Flipping from OFF → ON requires a hardened confirmation step
 * (`requireBiometric`) because the host OS will then accept screenshot,
 * mouse, and keyboard actions driven by IM replies. The confirmation
 * affordance is a tauri-dialog `ask()` modal on desktop and a
 * `window.confirm` on web; both produce a soft-verified result that we
 * audit so the operator can prove the flip was deliberate.
 *
 * OFF flips don't need the confirmation step — defaulting to "off" is
 * always safe.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { ComputerIcon, LoaderIcon } from "lucide-react"
import { toast } from "sonner"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Button } from "@/components/ui/button"
import { mutateConversationOverride } from "@/lib/connectors/inbox-writes"
import { appendAudit } from "@/lib/connectors/audit"
import { requireBiometric } from "@/lib/biometric/prompt"
import { cn } from "@/lib/utils"

export interface ComputerUseToggleProps {
  conversationKey: string
  sessionId: string
  adapterId: string
  currentValue: boolean
}

export function ComputerUseToggle({
  conversationKey,
  sessionId,
  adapterId,
  currentValue,
}: ComputerUseToggleProps) {
  const t = useTranslations("inbox.conversationHeader.computerUse")
  const [pending, setPending] = useState(false)

  const onToggle = async () => {
    if (pending) return
    setPending(true)
    try {
      const next = !currentValue
      if (next) {
        const result = await requireBiometric({
          title: t("confirmTitle"),
          message: t("confirmMessage"),
          confirmLabel: t("confirmEnable"),
          cancelLabel: t("confirmCancel"),
        })
        if (!result.ok) {
          toast.message(t("cancelled"))
          return
        }
        await mutateConversationOverride({
          kind: "upsert",
          input: { conversationKey, sessionId, allowComputerUse: true },
        })
        await appendAudit({
          adapterId,
          kind: "override.computer_use_changed",
          at: Date.now(),
          conversationKey,
          fields: {
            allowComputerUse: true,
            bioVerified: result.bioVerified,
            via: result.via,
          },
        })
        toast.success(t("enabled"))
      } else {
        await mutateConversationOverride({
          kind: "upsert",
          input: { conversationKey, sessionId, allowComputerUse: undefined },
        })
        await appendAudit({
          adapterId,
          kind: "override.computer_use_changed",
          at: Date.now(),
          conversationKey,
          fields: { allowComputerUse: false, bioVerified: false, via: "none" },
        })
        toast.message(t("disabled"))
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(false)
    }
  }

  const label = currentValue ? t("on") : t("off")
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void onToggle()}
          aria-pressed={currentValue}
          aria-label={t("aria", { state: label })}
          data-testid="computer-use-toggle"
          className={cn(
            "h-7 gap-1 px-2 text-xs",
            currentValue
              ? "border-destructive/40 bg-destructive/10 text-destructive"
              : "text-muted-foreground"
          )}
        >
          {pending ? (
            <LoaderIcon className="h-3 w-3 animate-spin" aria-hidden />
          ) : (
            <ComputerIcon className="h-3 w-3" aria-hidden />
          )}
          {label}
        </Button>
      </TooltipTrigger>
      <TooltipContent className="max-w-[240px] text-xs">
        {currentValue ? t("tooltipOn") : t("tooltipOff")}
      </TooltipContent>
    </Tooltip>
  )
}
