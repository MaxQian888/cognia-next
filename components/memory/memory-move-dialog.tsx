"use client"

/**
 * Move a memory to another namespace — the `relocate` command.
 *
 * Who can recall a memory is its namespace, so a memory learned in the wrong
 * place (a workspace fact saved as global, a character habit filed under a
 * workspace) used to be unfixable short of deleting it and typing it again,
 * which also threw away its history and evidence. Moving keeps both.
 */

import { useState } from "react"
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
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { MemoryNamespacePicker } from "@/components/memory/memory-namespace-picker"
import type { MemoryNamespaceTarget } from "@/lib/db/memories"
import type { Memory, MemoryScope } from "@/types/memory/memory"

const SCOPES: readonly MemoryScope[] = ["global", "workspace", "character", "agent"]

export interface MemoryMoveDialogProps {
  /** The memory to move; `undefined` closes the dialog. */
  memory: Memory | undefined
  onOpenChange: (open: boolean) => void
  /** Resolves whether the move landed; the dialog stays open on `false`. */
  onMove: (id: string, target: MemoryNamespaceTarget) => Promise<boolean>
}

function initialId(memory: Memory | undefined, scope: MemoryScope): string {
  if (!memory) return ""
  if (scope === "workspace") return memory.projectId ?? ""
  if (scope === "character") return memory.characterId ?? ""
  if (scope === "agent") return memory.agentId ?? ""
  return ""
}

export function MemoryMoveDialog({ memory, onOpenChange, onMove }: MemoryMoveDialogProps) {
  const t = useTranslations("memory.move")
  const tScopes = useTranslations("memory.scopes")
  const tAdd = useTranslations("memory.add")
  const [scope, setScope] = useState<MemoryScope>(memory?.scope ?? "global")
  const [targetId, setTargetId] = useState(() => initialId(memory, memory?.scope ?? "global"))
  const [busy, setBusy] = useState(false)

  // Reset the draft for each memory the dialog opens on (render-time state
  // adjustment, not an effect).
  const [forId, setForId] = useState(memory?.id)
  if (memory?.id !== forId) {
    setForId(memory?.id)
    setScope(memory?.scope ?? "global")
    setTargetId(initialId(memory, memory?.scope ?? "global"))
    setBusy(false)
  }

  const trimmed = targetId.trim()
  const target: MemoryNamespaceTarget | null =
    scope === "global"
      ? { scope: "global" }
      : !trimmed
        ? null
        : scope === "workspace"
          ? { scope: "workspace", projectId: trimmed }
          : scope === "character"
            ? { scope: "character", characterId: trimmed }
            : { scope: "agent", agentId: trimmed }
  const unchanged =
    Boolean(memory) && trimmed === initialId(memory, scope) && scope === memory?.scope

  const submit = () => {
    if (!memory || !target || unchanged || busy) return
    setBusy(true)
    void onMove(memory.id, target)
      .then((moved) => {
        if (moved) onOpenChange(false)
      })
      .finally(() => setBusy(false))
  }

  return (
    <Dialog open={Boolean(memory)} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="memory-move-dialog">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        {memory ? (
          <p className="line-clamp-3 rounded-md bg-muted/50 px-3 py-2 text-sm">{memory.text}</p>
        ) : null}
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="memory-move-scope">{t("scopeLabel")}</Label>
            <Select
              value={scope}
              onValueChange={(value) => {
                const next = value as MemoryScope
                setScope(next)
                setTargetId(initialId(memory, next))
              }}
            >
              <SelectTrigger id="memory-move-scope" aria-label={t("scopeLabel")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SCOPES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {tScopes(value)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {scope !== "global" ? (
            <MemoryNamespacePicker
              key={scope}
              kind={scope}
              label={
                scope === "workspace"
                  ? tAdd("projectIdLabel")
                  : scope === "character"
                    ? tAdd("characterIdLabel")
                    : tAdd("agentIdLabel")
              }
              value={targetId}
              onChange={setTargetId}
              testId="memory-move-target"
            />
          ) : null}
          <p className="text-xs text-muted-foreground">{t(`effect.${scope}`)}</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button
            onClick={submit}
            disabled={!target || unchanged || busy}
            data-testid="memory-move-confirm"
          >
            {t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
