"use client"

/**
 * Identity merge dialog.
 *
 * Shows two PlatformIdentityRow cards side by side. The user can select
 * which is primary and which is secondary, then click Merge to call
 * mergeIdentities(primaryId, secondaryId).
 *
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { ArrowRightIcon, UserIcon } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { mergeIdentities } from "@/lib/db/platform-identities"
import type { PlatformIdentityRow } from "@/lib/db/connector-types"

interface IdentityMergeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  identities: [PlatformIdentityRow, PlatformIdentityRow]
  lockedPrimaryId?: string
  onMerged?: (merged: PlatformIdentityRow) => void
}

export function IdentityMergeDialog({
  open,
  onOpenChange,
  identities,
  lockedPrimaryId,
  onMerged,
}: IdentityMergeDialogProps) {
  const t = useTranslations("connectors.identityMerge")
  const tupleKey = identities.map((identity) => identity.id).join(":")
  const initialPrimaryId =
    lockedPrimaryId && identities.some((identity) => identity.id === lockedPrimaryId)
      ? lockedPrimaryId
      : identities[0].id
  const stateKey = `${open ? "open" : "closed"}:${tupleKey}:${lockedPrimaryId ?? "unlocked"}`
  const [primarySelection, setPrimarySelection] = useState({
    key: stateKey,
    id: initialPrimaryId,
  })
  const [busy, setBusy] = useState(false)
  const [errorState, setErrorState] = useState<{ key: string; message: string | null }>({
    key: stateKey,
    message: null,
  })
  const primaryId = primarySelection.key === stateKey ? primarySelection.id : initialPrimaryId
  const error = errorState.key === stateKey ? errorState.message : null

  const primary = identities.find((identity) => identity.id === primaryId) ?? identities[0]
  const secondary = identities.find((identity) => identity.id !== primary.id) ?? identities[1]

  const handleMerge = async () => {
    setBusy(true)
    setErrorState({ key: stateKey, message: null })
    try {
      const result = await mergeIdentities(primary.id, secondary.id)
      if (!result.ok) {
        setErrorState({ key: stateKey, message: t(`errors.${result.reason}`) })
        return
      }
      onMerged?.(result.primary)
      onOpenChange(false)
    } catch {
      setErrorState({ key: stateKey, message: t("errors.unexpected") })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-3 mt-4">
          {identities.map((identity) => (
            <IdentityCard
              key={identity.id}
              identity={identity}
              isPrimary={identity.id === primaryId}
              locked={Boolean(lockedPrimaryId)}
              onClick={() => {
                if (!lockedPrimaryId) setPrimarySelection({ key: stateKey, id: identity.id })
              }}
            />
          ))}
        </div>

        {/* Merge direction arrow */}
        <div className="flex items-center justify-center gap-2 mt-2 text-xs text-muted-foreground">
          <Badge variant="outline">
            {t("secondary")} {secondary.displayName ?? secondary.remoteUserId}
          </Badge>
          <ArrowRightIcon className="h-4 w-4" />
          <Badge variant="default">
            {t("primary")} {primary.displayName ?? primary.remoteUserId}
          </Badge>
        </div>

        {error && (
          <p className="text-sm text-destructive mt-2" data-testid="merge-error">
            {error}
          </p>
        )}

        <div className="flex gap-2 mt-4">
          <Button onClick={() => void handleMerge()} disabled={busy} data-testid="merge-btn">
            {t("merge")}
          </Button>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={busy}
            data-testid="merge-cancel-btn"
          >
            {t("cancel")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function IdentityCard({
  identity,
  isPrimary,
  locked,
  onClick,
}: {
  identity: PlatformIdentityRow
  isPrimary: boolean
  locked: boolean
  onClick: () => void
}) {
  const t = useTranslations("connectors.identityMerge")
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={locked}
      data-testid={`identity-card-${identity.id}`}
      className={cn(
        "flex-1 rounded-lg border-2 p-3 text-left transition-colors",
        isPrimary ? "border-primary bg-primary/5" : "border-muted hover:border-muted-foreground/50"
      )}
    >
      <div className="flex items-center gap-2">
        <UserIcon className="h-5 w-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <p className="text-sm font-medium truncate">
            {identity.displayName ?? identity.remoteUserId}
          </p>
          <p className="text-xs text-muted-foreground truncate">{identity.platform}</p>
        </div>
      </div>
      {isPrimary && (
        <Badge
          className="mt-2 text-xs"
          variant="default"
          data-testid={`primary-badge-${identity.id}`}
        >
          {t("primaryBadge")}
        </Badge>
      )}
    </button>
  )
}
