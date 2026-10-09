"use client"

/**
 * Settings → Agent packs & knowledge (section id `characters`, kept so deep
 * links survive). The agents themselves moved to `/agents` (ADR-0220): their
 * list, detail, editor and builder live there, and this section keeps what is
 * not one agent's: the character packs agents are cloned from, and the
 * knowledge bases any agent can bind. The entry card at the top is how
 * someone who came here for an agent gets to it.
 */

import Link from "next/link"
import { useState, useSyncExternalStore } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  ArrowRightIcon,
  DownloadIcon,
  LibraryBigIcon,
  PackageIcon,
  PlusIcon,
  Trash2Icon,
  UploadIcon,
  UsersRoundIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
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
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import { listResolvedCharacters } from "@/lib/db/characters"
import {
  createKnowledgeBase,
  getKnowledgeBaseReferences,
  listKnowledgeBases,
} from "@/lib/db/knowledge-bases"
import type { KnowledgeBase, KnowledgeBaseReference } from "@/types/knowledge-base"
import {
  getCharacterPackRegistryVersion,
  getPackTrust,
  getPackWarnings,
  listCharacterPackEntries,
  subscribeCharacterPackRegistry,
} from "@/lib/plugin/registries/character-pack-registry"
import {
  formatPackWarnings,
  PackTrustChip,
} from "@/components/settings/character/pack-trust-badges"
import {
  deleteLocalPack,
  importLocalPack,
  LOCAL_PACK_PLUGIN_ID,
} from "@/lib/plugin/character-pack/local-pack-store"
import { usePluginMetadata } from "@/hooks/plugins/use-plugin-metadata"
import { KnowledgeBaseManager } from "@/components/settings/knowledge-base-manager"
import { removeKnowledgeBase } from "@/lib/knowledge-base/ingest/ingest-source"
import { tryBuildProjectKnowledgeDeps } from "@/lib/project-knowledge/runtime/build-deps"
import { AGENTS_ROUTE } from "@/lib/agents/routes"
import { isTauri } from "@/lib/tauri"
import { createLogger } from "@cognia/logging"

const log = createLogger("settings.characters")

export function CharactersSection() {
  const t = useTranslations("settings.characters")
  const agentCount = useLiveQuery(async () => (await listResolvedCharacters()).length, [])
  const knowledgeBases = useLiveQuery(() => listKnowledgeBases(), []) ?? []

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Label className="flex items-center gap-2">
          <PackageIcon className="size-4" />
          {t("title")}
        </Label>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>

      <Card className="flex flex-row items-center gap-3 p-4" data-testid="agents-entry-card">
        <UsersRoundIcon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{t("agentsEntry.title")}</p>
          <p className="text-xs text-muted-foreground">
            {t("agentsEntry.description", { count: agentCount ?? 0 })}
          </p>
        </div>
        <Button asChild size="sm" variant="outline">
          <Link href={AGENTS_ROUTE}>
            {t("agentsEntry.open")}
            <ArrowRightIcon className="ml-1 size-4" aria-hidden />
          </Link>
        </Button>
      </Card>

      <CharacterPacksSubsection />

      <KnowledgeBaseSubsection knowledgeBases={knowledgeBases} />
    </div>
  )
}

function KnowledgeBaseSubsection({ knowledgeBases }: { knowledgeBases: KnowledgeBase[] }) {
  const t = useTranslations("settings.characters.knowledgeBases")
  const [name, setName] = useState("")
  const [creating, setCreating] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<{
    knowledgeBase: KnowledgeBase
    references: KnowledgeBaseReference[]
  } | null>(null)

  const create = async () => {
    const trimmed = name.trim()
    if (!trimmed) return
    setCreating(true)
    try {
      await createKnowledgeBase({ name: trimmed })
      setName("")
      toast.success(t("created", { name: trimmed }))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setCreating(false)
    }
  }

  const inspectDelete = async (knowledgeBase: KnowledgeBase) => {
    try {
      const references = await getKnowledgeBaseReferences(knowledgeBase.id)
      setPendingDelete({ knowledgeBase, references })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }

  const confirmDelete = async () => {
    if (!pendingDelete) return
    try {
      const deps = await tryBuildProjectKnowledgeDeps()
      await removeKnowledgeBase(pendingDelete.knowledgeBase.id, {
        detachReferences: pendingDelete.references.length > 0,
        deps,
      })
      toast.success(t("deleted", { name: pendingDelete.knowledgeBase.name }))
      setPendingDelete(null)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <Card className="space-y-3 p-3">
      <div className="flex items-start gap-2">
        <LibraryBigIcon className="mt-0.5 size-4" />
        <div>
          <Label className="text-xs font-medium">{t("title")}</Label>
          <p className="text-[11px] text-muted-foreground">{t("description")}</p>
        </div>
      </div>
      <div className="flex gap-2">
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void create()
          }}
          placeholder={t("namePlaceholder")}
          aria-label={t("name")}
        />
        <Button
          type="button"
          variant="outline"
          disabled={creating || !name.trim()}
          onClick={() => void create()}
        >
          <PlusIcon className="mr-1 size-3.5" />
          {t("create")}
        </Button>
      </div>
      {knowledgeBases.length === 0 ? (
        <p className="text-[11px] italic text-muted-foreground">{t("empty")}</p>
      ) : (
        <div className="grid gap-1.5 sm:grid-cols-2">
          {knowledgeBases.map((knowledgeBase) => (
            <div
              key={knowledgeBase.id}
              className="flex items-center justify-between rounded-md border px-2 py-1.5"
            >
              <div className="min-w-0">
                <p className="truncate text-xs font-medium">{knowledgeBase.name}</p>
                {knowledgeBase.description && (
                  <p className="truncate text-[10px] text-muted-foreground">
                    {knowledgeBase.description}
                  </p>
                )}
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7 text-destructive hover:text-destructive"
                onClick={() => void inspectDelete(knowledgeBase)}
                aria-label={t("deleteAria", { name: knowledgeBase.name })}
              >
                <Trash2Icon className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}

      <KnowledgeBaseManager knowledgeBases={knowledgeBases} />

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete?.references.length
                ? t("deleteReferenced", { count: pendingDelete.references.length })
                : t("deleteUnreferenced")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {(pendingDelete?.references.length ?? 0) > 0 && (
            <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
              {pendingDelete?.references?.map((reference) => (
                <li key={`${reference.kind}:${reference.id}`}>{reference.name}</li>
              ))}
            </ul>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmDelete()}>
              {pendingDelete?.references.length ? t("detachAndDelete") : t("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}

// ===========================================================================
// ADR-0030 — Character packs subsection (overlay registry view + local
// pack import). Agents themselves live on `/agents` (ADR-0220); this is
// where the packs they can be cloned from are managed.
// ===========================================================================

function CharacterPacksSubsection() {
  const t = useTranslations("settings.characters")
  // Local imports/deletes and dependency-warning refreshes mutate this
  // in-memory registry without changing the plugin Zustand store. Subscribe to
  // the registry itself so every mutation reaches the Settings UI immediately.
  // The numeric snapshot is stable between mutations; using the entries array
  // as a snapshot would allocate on every render and make React loop forever.
  useSyncExternalStore(
    subscribeCharacterPackRegistry,
    getCharacterPackRegistryVersion,
    getCharacterPackRegistryVersion
  )
  const packs = listCharacterPackEntries()

  const handleImport = async () => {
    if (!isTauri()) {
      toast.error(t("packs.importUnavailableWeb"))
      return
    }
    try {
      const { open } = await import("@tauri-apps/plugin-dialog")
      const selection = await open({
        multiple: false,
        filters: [{ name: "Cognia Pack", extensions: ["json"] }],
      })
      if (!selection || typeof selection !== "string") return
      const { readTextFile } = await import("@tauri-apps/plugin-fs")
      const body = await readTextFile(selection)
      const result = await importLocalPack(body)
      if (result.ok) {
        toast.success(t("packs.importedToast", { id: result.value.packId }))
      } else {
        toast.error(result.error)
      }
    } catch (err) {
      log.error("pack_import_failed", err)
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const handleRescan = async () => {
    try {
      const { scanAndRegisterLocalPacks } =
        await import("@/lib/plugin/character-pack/local-pack-store")
      const result = await scanAndRegisterLocalPacks()
      log.info("pack_rescan_done", {
        registered: result.registered.length,
        skipped: result.skipped.length,
      })
      toast.success(
        t("packs.rescanToast", {
          registered: result.registered.length,
          skipped: result.skipped.length,
        })
      )
    } catch (err) {
      log.error("pack_rescan_failed", err)
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  if (packs.length === 0) {
    // Don't render the accordion at all when there are no packs —
    // the Import button moves into the main toolbar so users still
    // have a discoverable affordance. We render that affordance
    // alongside the empty hint below.
    if (!isTauri()) return null
    return (
      <div className="flex items-center justify-between rounded-md border border-dashed p-3">
        <div className="space-y-0.5">
          <p className="text-xs font-medium">{t("packs.title")}</p>
          <p className="text-[11px] text-muted-foreground">{t("packs.emptyHint")}</p>
        </div>
        <Button size="sm" variant="outline" onClick={() => void handleImport()}>
          <UploadIcon className="mr-2 size-3.5" />
          {t("packs.importJsonAction")}
        </Button>
      </div>
    )
  }

  return (
    <Accordion type="single" collapsible defaultValue="packs">
      <AccordionItem value="packs">
        <AccordionTrigger className="text-sm">
          <span className="flex items-center gap-2">
            <PackageIcon className="size-4" />
            {t("packs.title")}
            <Badge variant="secondary" className="ml-1 text-[10px]">
              {packs.length}
            </Badge>
          </span>
        </AccordionTrigger>
        <AccordionContent className="space-y-2">
          {packs.map((entry) => (
            <PackRow
              key={`${entry.pluginId ?? ""}:${entry.id}`}
              packId={entry.id}
              packName={entry.entry.name}
              packVersion={entry.entry.version}
              packDescription={entry.entry.description}
              packIcon={entry.entry.icon}
              characters={entry.entry.characters}
              pluginId={entry.pluginId}
            />
          ))}
          {isTauri() && (
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => void handleImport()}>
                <UploadIcon className="mr-2 size-3.5" />
                {t("packs.importJsonAction")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void handleRescan()}>
                {t("packs.rescan")}
              </Button>
            </div>
          )}
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  )
}

function PackRow({
  packId,
  packName,
  packVersion,
  packDescription,
  packIcon,
  characters,
  pluginId,
}: {
  packId: string
  packName: string
  packVersion: string
  packDescription?: string
  packIcon?: { emoji?: string; color?: string }
  characters: ReadonlyArray<import("@/types/plugin/plugin-character-pack").PluginCharacterDef>
  pluginId: string | undefined
}) {
  const t = useTranslations("settings.characters")
  const pluginMeta = usePluginMetadata(pluginId)
  const isLocal = pluginId === LOCAL_PACK_PLUGIN_ID || !pluginId
  const sourceText = isLocal
    ? t("packs.sourceLocal")
    : t("packs.sourcePlugin", { name: pluginMeta?.name ?? pluginId })
  const [expanded, setExpanded] = useState(false)
  // ADR-0030 §B.6 — surface pack-level warnings on the pack header chip
  // so the user knows at a glance that something inside this pack has a
  // missing dependency. Character-level detail is reached by expanding.
  const packWarnings = getPackWarnings(packId)
  // ADR-0030 — signature trust, which is a different question from the
  // dependency warnings above: it attests to who authored the pack, not to
  // what happens to be installed here. Plugin-contributed packs suppress the
  // "unsigned" chip; see `PackTrustChipProps.showUnsigned`.
  const packTrust = getPackTrust(packId)

  const handleDelete = async () => {
    const result = await deleteLocalPack(packId)
    if (result.ok) {
      toast.success(t("packs.deletedToast", { id: packId }))
    } else {
      toast.error(result.error)
    }
  }

  const handleExport = async () => {
    try {
      const { exportPack } = await import("@/lib/plugin/character-pack/local-pack-store")
      const result = exportPack(packId)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      if (isTauri()) {
        const { save } = await import("@tauri-apps/plugin-dialog")
        const target = await save({
          defaultPath: result.value.filename,
          filters: [{ name: "Cognia Pack", extensions: ["json"] }],
        })
        if (!target) return
        const { writeTextFile } = await import("@tauri-apps/plugin-fs")
        await writeTextFile(target, result.value.body)
        toast.success(t("packs.exportedToast", { path: target }))
      } else {
        const blob = new Blob([result.value.body], { type: "application/json" })
        const url = URL.createObjectURL(blob)
        const a = document.createElement("a")
        a.href = url
        a.download = result.value.filename
        a.click()
        URL.revokeObjectURL(url)
        toast.success(t("packs.exportedToastBrowser"))
      }
    } catch (err) {
      log.error("pack_export_failed", err, { packId })
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <Card className="p-3">
      <div className="flex items-start gap-3">
        <span
          className="flex size-9 shrink-0 items-center justify-center rounded-md text-base"
          style={{
            backgroundColor: packIcon?.color ?? "oklch(0.7 0.1 250)",
            color: "white",
          }}
          aria-hidden
        >
          {packIcon?.emoji ?? "📦"}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium">{packName}</p>
            <Badge variant="outline" className="font-mono text-[10px]">
              v{packVersion}
            </Badge>
            <Badge variant="outline" className="text-[10px]">
              {sourceText}
            </Badge>
            <PackTrustChip trust={packTrust} showUnsigned={isLocal} />
            {packWarnings.length > 0 && (
              <Badge
                variant="outline"
                className="border-yellow-500/40 bg-yellow-500/10 text-[10px] text-yellow-700 dark:text-yellow-300"
                title={formatPackWarnings(packWarnings, t)}
              >
                {t("badge.missingDep", { count: packWarnings.length })}
              </Badge>
            )}
          </div>
          {packDescription && (
            <p className="mt-0.5 text-xs text-muted-foreground">{packDescription}</p>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mt-1 h-auto justify-start p-0 text-left text-[11px] font-normal text-muted-foreground hover:bg-transparent hover:text-foreground"
            onClick={() => setExpanded((v) => !v)}
            aria-label={
              expanded
                ? t("packs.collapseAria", { id: packId })
                : t("packs.expandAria", { id: packId })
            }
          >
            {t("packs.characterCount", { count: characters.length })}
            <span aria-hidden> {expanded ? "▾" : "▸"}</span>
          </Button>
          {expanded && (
            <ul className="mt-2 space-y-1 border-l-2 border-border pl-3">
              {characters.map((ch) => (
                <li key={ch.localId} className="text-[11px]">
                  <span className="font-medium">{ch.name}</span>
                  {ch.description && (
                    <span className="text-muted-foreground"> — {ch.description}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => void handleExport()}
            aria-label={t("exportPackAria", { name: packName })}
            title={t("actions.exportPack")}
          >
            <DownloadIcon className="size-3.5" />
          </Button>
          {isLocal && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 text-destructive hover:text-destructive"
                  aria-label={t("packs.deleteAria", { id: packId })}
                  title={t("packs.delete")}
                >
                  <Trash2Icon className="size-3.5" />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t("packs.removeTitle")}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {t("packs.removeBody", { id: packId })}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
                  <AlertDialogAction onClick={() => void handleDelete()}>
                    {t("remove")}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </div>
    </Card>
  )
}
