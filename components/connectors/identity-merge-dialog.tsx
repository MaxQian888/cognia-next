"use client"

/**
 * Identity merge dialog.
 *
 * Shows two PlatformIdentityRow cards side by side. The user can select
 * which is primary and which is secondary, then click Merge to call
 * mergeIdentities(primaryId, secondaryId).
 *
 * Note: The spec mentions drag-and-drop; Phase 1 ships a button-based merge
 * for reliability across all environments. DnD can be layered on in Phase 2.
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
  onMerged?: (merged: PlatformIdentityRow) => void
}

export function IdentityMergeDialog({
  open,
  onOpenChange,
  identities,
  onMerged,
}: IdentityMergeDialogProps) {
  const t = useTranslations("connectors.identityMerge")
  const [primaryId, setPrimaryId] = useState<string>(identities[0].id)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const secondary = identities.find((i) => i.id !== primaryId)!
  const primary = identities.find((i) => i.id === primaryId)!

  const handleMerge = async () => {
    setBusy(true)
    setError(null)
    try {
      const merged = await mergeIdentities(primaryId, secondary.id)
      onMerged?.(merged)
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Merge failed")
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
              onClick={() => setPrimaryId(identity.id)}
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
  onClick,
}: {
  identity: PlatformIdentityRow
  isPrimary: boolean
  onClick: () => void
}) {
  const t = useTranslations("connectors.identityMerge")
  return (
    <button
      type="button"
      onClick={onClick}
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
