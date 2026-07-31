"use client"

// Aside picker + lifecycle menu for the workbench sidechat.
//
// A conversation used to own exactly one aside, forever: the row id was a pure
// function of the binding, and no surface could create, rename, clear, delete or
// graduate one. This is the missing lifecycle — the list lives in the panel
// header, above the aside it selects.

import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { useLiveQuery } from "dexie-react-hooks"
import type { SessionSurfaceBinding } from "@cognia/agent-config-types"
import {
  CheckIcon,
  ChevronDownIcon,
  MessagesSquareIcon,
  MoreHorizontalIcon,
  PlusIcon,
} from "lucide-react"
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
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  clearResourceWorkbenchSession,
  createResourceWorkbenchSession,
  deleteResourceWorkbenchSession,
  listResourceWorkbenchSessions,
  promoteResourceWorkbenchSession,
  renameResourceWorkbenchSession,
} from "@/lib/db/resource-workbench-sessions"
import { useChatStore } from "@/stores/chat"
import { createLogger } from "@cognia/logging"

const log = createLogger("aside-switcher")

interface Props {
  binding: SessionSurfaceBinding
  /** Currently rendered aside. */
  activeId: string
  /** Select a different aside. */
  onSelect: (sessionId: string) => void
  /**
   * The aside `ensureResourceWorkbenchSession` auto-creates. It cannot be
   * deleted — deleting it would only make the panel mint it again on the next
   * open, so the action would read as broken rather than destructive.
   */
  primaryId: string
}

type PendingDialog =
  | { kind: "rename"; id: string; title: string }
  | { kind: "clear"; id: string }
  | { kind: "delete"; id: string; title: string }
  | null

export function AsideSwitcher({ binding, activeId, onSelect, primaryId }: Props) {
  const t = useTranslations("contextWorkbench.asides")
  const [pending, setPending] = useState<PendingDialog>(null)
  const [renameDraft, setRenameDraft] = useState("")
  const [busy, setBusy] = useState(false)

  const bindingJson = JSON.stringify(binding)
  const queriedAsides = useLiveQuery(
    () => listResourceWorkbenchSessions(JSON.parse(bindingJson) as SessionSurfaceBinding),
    [bindingJson]
  )
  const asides = useMemo(() => queriedAsides ?? [], [queriedAsides])

  const active = useMemo(() => asides.find((a) => a.id === activeId), [asides, activeId])

  // The rendered aside was deleted from under us (or never existed) — fall back
  // to whatever is left rather than showing an empty panel with a dead label.
  useEffect(() => {
    if (asides.length === 0 || active) return
    onSelect(asides[0].id)
  }, [asides, active, onSelect])

  const onCreate = useCallback(async () => {
    setBusy(true)
    try {
      const created = await createResourceWorkbenchSession(
        binding,
        t("defaultName", { n: asides.length + 1 })
      )
      onSelect(created.id)
    } catch (err) {
      log.error("aside-create-failed", { error: String(err) })
      toast.error(t("createError"))
    } finally {
      setBusy(false)
    }
  }, [asides.length, binding, onSelect, t])

  const runPending = useCallback(async () => {
    if (!pending) return
    setBusy(true)
    try {
      if (pending.kind === "rename") {
        await renameResourceWorkbenchSession(pending.id, renameDraft)
      } else if (pending.kind === "clear") {
        await clearResourceWorkbenchSession(pending.id)
        // The panel keeps its messages in the store; make it re-read Dexie
        // rather than splicing an emptied thread in memory.
        useChatStore.getState().requestSessionMessagesReload(pending.id)
        toast.success(t("cleared"))
      } else {
        await deleteResourceWorkbenchSession(pending.id)
        toast.success(t("deleted"))
      }
      setPending(null)
    } catch (err) {
      log.error("aside-action-failed", { kind: pending.kind, error: String(err) })
      toast.error(t("actionError"))
    } finally {
      setBusy(false)
    }
  }, [pending, renameDraft, t])

  const onPromote = useCallback(
    async (id: string) => {
      setBusy(true)
      try {
        const promoted = await promoteResourceWorkbenchSession(id)
        // Bring it forward as a real conversation — the point of promoting is
        // that it stops being confined to the dock.
        const store = useChatStore.getState()
        store.openSession(promoted.id)
        store.setActiveSession(promoted.id)
        toast.success(t("promoted"))
      } catch (err) {
        log.error("aside-promote-failed", { error: String(err) })
        toast.error(t("actionError"))
      } finally {
        setBusy(false)
      }
    },
    [t]
  )

  return (
    <div
      className="flex h-9 shrink-0 items-center gap-1 border-b px-2"
      data-testid="aside-switcher"
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 min-w-0 flex-1 justify-start gap-1.5 px-1.5"
            aria-label={t("switchAria")}
          >
            <MessagesSquareIcon className="size-3.5 shrink-0" />
            <span className="truncate text-xs">{active?.title ?? t("fallbackName")}</span>
            <ChevronDownIcon className="ml-auto size-3.5 shrink-0 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-w-[16rem]">
          <DropdownMenuLabel className="text-xs">{t("listLabel")}</DropdownMenuLabel>
          {asides.map((aside) => (
            <DropdownMenuItem
              key={aside.id}
              onSelect={() => onSelect(aside.id)}
              className="gap-2 text-xs"
            >
              <CheckIcon
                className={aside.id === activeId ? "size-3.5" : "size-3.5 opacity-0"}
                aria-hidden
              />
              <span className="truncate">{aside.title}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <Button
        variant="ghost"
        size="icon-sm"
        disabled={busy}
        aria-label={t("newAria")}
        onClick={() => void onCreate()}
      >
        <PlusIcon className="size-4" />
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={t("moreAria")}>
            <MoreHorizontalIcon className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            disabled={!active}
            onSelect={() => {
              if (!active) return
              setRenameDraft(active.title)
              setPending({ kind: "rename", id: active.id, title: active.title })
            }}
          >
            {t("rename")}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!active}
            onSelect={() => active && setPending({ kind: "clear", id: active.id })}
          >
            {t("clear")}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!active} onSelect={() => active && void onPromote(active.id)}>
            {t("promote")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            // Deleting the primary aside would only make the panel mint it
            // again on the next open, so the action is withheld rather than
            // being a no-op that looks broken.
            disabled={!active || active.id === primaryId}
            onSelect={() =>
              active && setPending({ kind: "delete", id: active.id, title: active.title })
            }
          >
            {t("delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={pending?.kind === "rename"} onOpenChange={(open) => !open && setPending(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("renameTitle")}</DialogTitle>
          </DialogHeader>
          <Input
            value={renameDraft}
            onChange={(e) => setRenameDraft(e.target.value)}
            // Distinct from the dialog title: `DialogContent` is labelled BY
            // that title, so reusing it would give the dialog and its input the
            // same accessible name — ambiguous for a screen reader, and for
            // anything querying by label.
            aria-label={t("nameLabel")}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setPending(null)} disabled={busy}>
              {t("cancel")}
            </Button>
            <Button onClick={() => void runPending()} disabled={busy || !renameDraft.trim()}>
              {t("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={pending?.kind === "clear" || pending?.kind === "delete"}
        onOpenChange={(open) => !open && setPending(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pending?.kind === "delete" ? t("deleteTitle") : t("clearTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pending?.kind === "delete" ? t("deleteBody") : t("clearBody")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(e) => {
                e.preventDefault()
                void runPending()
              }}
            >
              {pending?.kind === "delete" ? t("delete") : t("clear")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
