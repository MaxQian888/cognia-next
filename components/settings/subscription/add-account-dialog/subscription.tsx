"use client"

import { useSubscriptionProviders } from "@/lib/subscription/core/hooks"
import { AnthropicAddAccountDialog } from "./anthropic"
import { CodexAddAccountDialog, type CodexLoginMode } from "./codex"
import { ManagedKeyAccountDialog, type ManagedKeyAccountDialogProps } from "./managed-key"
import { useTranslations } from "next-intl"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"

export interface SubscriptionAccountDialogProps extends Omit<
  ManagedKeyAccountDialogProps,
  "definition"
> {
  /** Missing means create a custom subscription definition with its first key. */
  providerId?: string
  codexMode?: CodexLoginMode
}

/** Authentication strategy dispatch; new API-key providers require only registry data. */
export function SubscriptionAccountDialog({
  providerId,
  codexMode,
  ...props
}: SubscriptionAccountDialogProps) {
  const providers = useSubscriptionProviders()
  const definition = providers.find((entry) => entry.id === providerId)
  const t = useTranslations("subscription.managedKey")
  if (!props.open) return null
  if (providerId && (!definition || definition.available === false)) {
    return (
      <Dialog open={props.open} onOpenChange={props.onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("unavailableTitle")}</DialogTitle>
            <DialogDescription>{t("unavailable")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => props.onOpenChange(false)}>{t("cancel")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }
  if (definition?.authMode === "anthropic-oauth") return <AnthropicAddAccountDialog {...props} />
  if (definition?.authMode === "codex-oauth")
    return <CodexAddAccountDialog {...props} initialMode={codexMode} />
  return <ManagedKeyAccountDialog key={providerId ?? "custom"} {...props} definition={definition} />
}
