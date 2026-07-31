"use client"

/**
 * Entities subtab — searchable list of `ProfileEntity` rows with per-row
 * pin/edit/delete actions and an "Add entity" button. Pinned rows sort
 * first; the rest are alphabetical.
 *
 * All writes go through `lib/db/twin-profile.ts`. The parent passes the
 * entities array as a prop (sourced from a `useLiveQuery` upstream); we
 * never read from Dexie directly here so the rendering stays pure.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
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
import { PinIcon, PinOffIcon } from "lucide-react"
import { addEntity, removeEntity, setEntityPinned, updateEntity } from "@/lib/db/twin-profile"
import type { ProfileEntity } from "@/types/twin"
import { EntityEditorDialog } from "./entity-editor-dialog"

export interface EntitiesSubtabProps {
  twinId: string
  entities: ProfileEntity[]
}

function sortPinnedFirstThenAlpha(a: ProfileEntity, b: ProfileEntity): number {
  const ap = a.pinned ? 1 : 0
  const bp = b.pinned ? 1 : 0
  if (ap !== bp) return bp - ap
  return a.name.localeCompare(b.name)
}

export function EntitiesSubtab({ twinId, entities }: EntitiesSubtabProps) {
  const t = useTranslations("twin.persona")
  const [query, setQuery] = useState("")
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingEntity, setEditingEntity] = useState<ProfileEntity | null>(null)
  const [busy, setBusy] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<ProfileEntity | null>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const sorted = [...entities].sort(sortPinnedFirstThenAlpha)
    if (!q) return sorted
    return sorted.filter((e) => {
      if (e.name.toLowerCase().includes(q)) return true
      if (e.aliases.some((a) => a.toLowerCase().includes(q))) return true
      if (e.relation?.toLowerCase().includes(q)) return true
      return false
    })
  }, [entities, query])

  const openAdd = () => {
    setEditingEntity(null)
    setEditorOpen(true)
  }
  const openEdit = (entity: ProfileEntity) => {
    setEditingEntity(entity)
    setEditorOpen(true)
  }

  const handleSave = async (next: ProfileEntity) => {
    setBusy(true)
    try {
      if (editingEntity) {
        await updateEntity(twinId, editingEntity.name, next)
      } else {
        await addEntity(twinId, next)
      }
      setEditorOpen(false)
    } finally {
      setBusy(false)
    }
  }

  const handleTogglePin = async (entity: ProfileEntity) => {
    await setEntityPinned(twinId, entity.name, !entity.pinned)
  }

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return
    setBusy(true)
    try {
      await removeEntity(twinId, deleteTarget.name)
    } finally {
      setBusy(false)
      setDeleteTarget(null)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col items-stretch gap-2 @sm/twin:flex-row @sm/twin:items-center">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("searchPlaceholder")}
          data-testid="entities-search"
          className="@sm/twin:max-w-xs"
        />
        <div className="flex-1" />
        <Button size="sm" onClick={openAdd} data-testid="entities-add">
          {t("entity.add")}
        </Button>
      </div>

      {filtered.length === 0 ? (
        <Card className="p-6 text-center">
          <p className="text-muted-foreground text-sm">
            {entities.length === 0 ? t("empty.entities") : t("empty.noMatch")}
          </p>
        </Card>
      ) : (
        <ul className="flex flex-col gap-2">
          {filtered.map((entity) => (
            <li key={entity.name.toLowerCase()} className="list-none">
              <Card
                className="flex items-center justify-between gap-3 p-3"
                data-testid={`entity-row-${entity.name}`}
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-medium">{entity.name}</span>
                    <Badge variant="outline" className="shrink-0">
                      {t(`entity.role.${entity.role}`)}
                    </Badge>
                    {entity.pinned ? (
                      <Badge variant="secondary" className="shrink-0">
                        {t("badges.pinned")}
                      </Badge>
                    ) : null}
                  </div>
                  {entity.aliases.length > 0 ? (
                    <p className="text-muted-foreground line-clamp-1 text-xs">
                      {t("entity.aliasesLabel")}: {entity.aliases.join(", ")}
                    </p>
                  ) : null}
                  {entity.relation ? (
                    <p className="text-muted-foreground line-clamp-2 text-xs">{entity.relation}</p>
                  ) : null}
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => void handleTogglePin(entity)}
                    aria-label={entity.pinned ? t("actions.unpin") : t("actions.pin")}
                    data-testid={`entity-pin-${entity.name}`}
                  >
                    {entity.pinned ? (
                      <PinOffIcon className="size-4" />
                    ) : (
                      <PinIcon className="size-4" />
                    )}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => openEdit(entity)}
                    data-testid={`entity-edit-${entity.name}`}
                  >
                    {t("actions.edit")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setDeleteTarget(entity)}
                    data-testid={`entity-delete-${entity.name}`}
                  >
                    {t("actions.delete")}
                  </Button>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <EntityEditorDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        entity={editingEntity}
        onSave={handleSave}
        busy={busy}
      />

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(o) => (o ? null : setDeleteTarget(null))}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("entity.deleteConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("entity.deleteConfirmBody", { name: deleteTarget?.name ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void handleConfirmDelete()}
              data-testid="entity-delete-confirm"
            >
              {t("actions.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
