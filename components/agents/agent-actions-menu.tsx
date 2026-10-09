"use client"

/**
 * The "…" menu for one agent (ADR-0220), shared by the table rows and the
 * detail header. Every item runs through `useAgentActions`; what is offered
 * follows the agent's source (`describeAgentSource`), so a built-in agent
 * never shows "Delete" and only a clone behind its pack shows the update
 * actions.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import {
  CopyIcon,
  DownloadIcon,
  GitBranchIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  PencilIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  Trash2Icon,
  UnlinkIcon,
} from "lucide-react"
import type { Character } from "@cognia/agent-config-types"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { CharacterPackUpdateDialog } from "@/components/settings/character-pack-update-dialog"
import { useAgentActions } from "@/hooks/agents/use-agent-actions"
import { describeAgentSource } from "@/lib/agents/agent-source"

export interface AgentActionsMenuProps {
  agent: Character
  /** Clones of the same pack waiting on an update, this one excluded. Drives "apply to all". */
  siblingPendingCount?: number
  /** Open an agent (the copy, the new variant, the fresh clone) after an action made it. */
  onOpenAgent: (id: string, mode?: "edit") => void
  /** After the agent was deleted, e.g. to leave its detail page. */
  onDeleted?: () => void
  onStartChat?: () => void
  /** Offer "Edit" (switches the detail to its edit mode). */
  onEdit?: () => void
  triggerClassName?: string
}

export function AgentActionsMenu({
  agent,
  siblingPendingCount = 0,
  onOpenAgent,
  onDeleted,
  onStartChat,
  onEdit,
  triggerClassName,
}: AgentActionsMenuProps) {
  const t = useTranslations("settings.characters")
  const tc = useTranslations("agentsConsole.actions")
  const actions = useAgentActions()
  const source = describeAgentSource(agent)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const variant = agent.variant

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className={triggerClassName ?? "size-8"}
            aria-label={tc("menuAria", { name: agent.name })}
            data-testid="agent-actions-trigger"
          >
            <MoreHorizontalIcon className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          {onStartChat ? (
            <DropdownMenuItem onSelect={onStartChat}>
              <MessageSquareIcon className="size-4" />
              {tc("chat")}
            </DropdownMenuItem>
          ) : null}
          {onEdit && source.editable ? (
            <DropdownMenuItem onSelect={onEdit}>
              <PencilIcon className="size-4" />
              {t("edit")}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            onSelect={() =>
              void actions.duplicate(agent).then((copy) => copy && onOpenAgent(copy.id, "edit"))
            }
          >
            <CopyIcon className="size-4" />
            {t("duplicate")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() =>
              void actions
                .createVariant(agent)
                .then((created) => created && onOpenAgent(created.id, "edit"))
            }
          >
            <GitBranchIcon className="size-4" />
            {t("variants.create")}
          </DropdownMenuItem>
          {variant ? (
            <>
              <DropdownMenuItem
                disabled={variant.ownFields.length === 0}
                onSelect={() => void actions.resetVariant(agent)}
              >
                <RotateCcwIcon className="size-4" />
                {t("variants.reset")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void actions.detachVariant(agent)}>
                <UnlinkIcon className="size-4" />
                {t("variants.detach")}
              </DropdownMenuItem>
            </>
          ) : null}
          {source.updateAvailable ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                {t("badge.updateAvailable")}
              </DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => actions.requestApplyUpdate(agent)}>
                <RefreshCwIcon className="size-4" />
                {t("actions.applyUpdate")}
              </DropdownMenuItem>
              {siblingPendingCount >= 2 ? (
                <DropdownMenuItem onSelect={() => void actions.applyUpdateForPack(agent)}>
                  <RefreshCwIcon className="size-4" />
                  {t("actions.applyUpdateBatch", { count: siblingPendingCount })}
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem
                onSelect={() =>
                  void actions
                    .recloneFromPack(agent)
                    .then((fresh) => fresh && onOpenAgent(fresh.id))
                }
              >
                <CopyIcon className="size-4" />
                {t("actions.recloneFromPack")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void actions.dismissUpdate(agent)}>
                {t("actions.dismissUpdate")}
              </DropdownMenuItem>
            </>
          ) : null}
          {source.packId ? (
            <DropdownMenuItem onSelect={() => void actions.exportPack(agent)}>
              <DownloadIcon className="size-4" />
              {t("actions.exportPack")}
            </DropdownMenuItem>
          ) : null}
          {source.deletable ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => setConfirmDelete(true)}>
                <Trash2Icon className="size-4" />
                {t("delete")}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("removeTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("removeBody", { name: agent.name })}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                void actions.remove(agent).then((removed) => {
                  if (removed) onDeleted?.()
                })
              }
            >
              {t("remove")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <CharacterPackUpdateDialog
        open={actions.applyUpdateTarget !== null}
        characterId={actions.applyUpdateTarget?.id ?? null}
        characterName={actions.applyUpdateTarget?.name ?? ""}
        onCancel={actions.cancelApplyUpdate}
        onConfirm={actions.confirmApplyUpdate}
      />
    </>
  )
}
