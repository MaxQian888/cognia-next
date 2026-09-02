"use client"

/**
 * AgentTeamTemplatesSection — Settings panel for agent-team templates.
 *
 * Surfaces both the eight built-in templates (seeded into the store via
 * `builtInTemplatesMap` in `initial-state.ts`) and any user-created templates,
 * with the same built-in / duplicate-to-fork / edit / delete UX used by
 * `teams-section.tsx` for character teams. The store still owns CRUD: the
 * built-in guards live there (deleteTemplate / updateTemplate refuse to mutate
 * `isBuiltIn: true` rows), and the same registry serves
 * `ctx.team.instantiateTemplate` for plugins.
 *
 * The LIFECYCLE, though, is the unified template platform's. Picking "Use"
 * goes through `service.preflight` and `service.instantiate` so the Squad it
 * creates gets a `TemplateInstanceRecord`, which is the only thing that makes
 * "update from template" and Detach expressible later on. It used to call the
 * store writer directly, so no Squad in the app had lineage at all.
 *
 * A user row also carries what the platform knows about it (draft, published
 * version, forked from) and the four actions that only exist there: Publish,
 * which is what turns a private draft into something packageable, Export, Fork,
 * and Share, which hands the published release over as a link instead of a
 * file. Plugin rows stay read-only, because the overlay registry is their
 * source of truth and this panel is not it.
 *
 * Import is deliberately the platform's import, not the store's. The store had
 * an `importTemplates` that took bare JSON with no signature, no manifest and
 * no size bounds, and nothing ever called it. `service.importPackage` checks
 * every one of those, so it replaced it rather than joining it.
 */

import { useMemo, useRef, useState, useCallback } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import {
  CopyIcon,
  DownloadIcon,
  GitForkIcon,
  Link2Icon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  Trash2Icon,
  UploadIcon,
  UploadCloudIcon,
  UsersIcon,
} from "lucide-react"
import { nanoid } from "nanoid"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
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
import { toast } from "@/components/ui/sonner"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  TemplateExportDialog,
  type TemplateExportRequest,
} from "@/components/templates/template-export-dialog"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import type { AgentTeamTemplate } from "@/types/agent/agent-team"
import { createLogger } from "@cognia/logging"
import {
  getTemplateWarnings,
  listAgentTeamTemplateEntries,
  type PluginAgentTeamTemplateWarning,
} from "@/lib/plugin/registries/agent-team-template-registry"
import { projectPluginTemplate } from "@/lib/agent-team/project-plugin-template"
import { publishSquadTemplateToPlatform } from "@/lib/agent-team/publish-template-to-platform"
import { applySquadTemplate } from "@/lib/agent-team/apply-squad-template"
import {
  squadTemplateShareDefinition,
  type SquadTemplatePlatformStatus,
} from "@/lib/agent-team/squad-template-platform"
import { TemplateDefinitionShareButton } from "@/components/share/template-definition-share-button"
import {
  useSquadTemplatePlatformStatuses,
  type SquadTemplateStatusRow,
} from "@/hooks/squads/use-squad-template-platform-statuses"
import { usePlatform } from "@/hooks/use-platform"
import type { TemplateDefinitionEnvelope, TemplatePlatform } from "@/lib/templates/contracts"
import { makeTemplateDraftId } from "@/lib/templates/draft-id"
import { downloadTemplatePackage, templatePackageFilename } from "@/lib/templates/download-package"
import type { InspectedTemplatePackage } from "@/lib/templates/package"
import { getTemplateRuntime, type TemplateRuntime } from "@/lib/templates/runtime"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

const log = createLogger("settings.agent-teams")

const CATEGORIES: AgentTeamTemplate["category"][] = [
  "review",
  "research",
  "development",
  "debugging",
  "analysis",
  "general",
  "documentation",
  "security",
]

export interface AgentTeamTemplatesSectionProps {
  /** Injected in tests. Production resolves the singleton runtime. */
  runtime?: TemplateRuntime
}

export function AgentTeamTemplatesSection({ runtime }: AgentTeamTemplatesSectionProps = {}) {
  const t = useTranslations("settings.agentTeams")
  const tCommon = useTranslations("common")
  // The share control speaks the app-wide share vocabulary, so its label and
  // its refusals read the same here as in Discover and the Studio.
  const tShare = useTranslations("share")
  const router = useRouter()
  const platform = usePlatform()
  const templatePlatform: TemplatePlatform =
    platform === "mobile" ? "mobile" : platform === "web" ? "web" : "desktop"
  const resolvedRuntime = useMemo(() => runtime ?? getTemplateRuntime(), [runtime])

  const templates = useAgentTeamStore((s) => s.templates)
  const createTeam = useAgentTeamStore((s) => s.createTeam)
  const addTeammate = useAgentTeamStore((s) => s.addTeammate)
  const createTask = useAgentTeamStore((s) => s.createTask)
  const addTemplate = useAgentTeamStore((s) => s.addTemplate)
  const updateTemplate = useAgentTeamStore((s) => s.updateTemplate)
  const deleteTemplate = useAgentTeamStore((s) => s.deleteTemplate)

  const [editing, setEditing] = useState<AgentTeamTemplate | null>(null)
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState(false)
  const [exportTarget, setExportTarget] = useState<
    { origin: TemplateDefinitionEnvelope; releases: TemplateDefinitionEnvelope[] } | undefined
  >(undefined)
  const [pendingImport, setPendingImport] = useState<
    { bytes: Uint8Array; inspected: InspectedTemplatePackage } | undefined
  >(undefined)
  const importRef = useRef<HTMLInputElement>(null)

  /**
   * Project a plugin-contributed `PluginAgentTeamTemplateDef` into the
   * `AgentTeamTemplate` shape the row component consumes. The runtime id
   * is `<pluginId>:<defId>` so plugin templates can never collide with
   * store-resident ids.
   */
  // Built-ins first, then user templates by name, then plugin overlay
  // entries last. Within built-ins, group by category so related
  // templates sit together. Plugin entries carry source metadata in
  // `pluginIndex` so the row can render badges + dep warnings.
  const sortedTemplates = useMemo(() => {
    const local = Object.values(templates)
    const pluginEntries = listAgentTeamTemplateEntries()
    const pluginIndex = new Map<
      string,
      { pluginId?: string; warnings: readonly PluginAgentTeamTemplateWarning[] }
    >()
    const pluginProjected: AgentTeamTemplate[] = pluginEntries.map((entry) => {
      const projected = projectPluginTemplate(entry)
      pluginIndex.set(projected.id, {
        pluginId: entry.pluginId,
        warnings: getTemplateWarnings(entry.id),
      })
      return projected
    })
    const merged = [...local, ...pluginProjected]
    merged.sort((a, b) => {
      const aPlugin = pluginIndex.has(a.id)
      const bPlugin = pluginIndex.has(b.id)
      if (aPlugin !== bPlugin) return aPlugin ? 1 : -1
      const aBuiltIn = a.isBuiltIn ?? false
      const bBuiltIn = b.isBuiltIn ?? false
      if (aBuiltIn !== bBuiltIn) return aBuiltIn ? -1 : 1
      if (aBuiltIn && bBuiltIn && a.category !== b.category) {
        return a.category.localeCompare(b.category)
      }
      return a.name.localeCompare(b.name)
    })
    return { merged, pluginIndex }
  }, [templates])

  /**
   * The rows whose lifecycle belongs to this user.
   *
   * Built-ins are a per-boot overlay the app owns, and plugin rows belong to
   * the registry that contributed them, so neither is publishable, exportable
   * or forkable from here. Memoized because it is an effect dependency of the
   * status read.
   */
  const ownedRows = useMemo<SquadTemplateStatusRow[]>(
    () =>
      sortedTemplates.merged
        .filter((tpl) => !tpl.isBuiltIn && !sortedTemplates.pluginIndex.has(tpl.id))
        .map((template) => ({ template })),
    [sortedTemplates]
  )
  const statuses = useSquadTemplatePlatformStatuses(ownedRows, resolvedRuntime)

  const fail = useCallback(
    (error: unknown) => toast.error(error instanceof Error ? error.message : String(error)),
    []
  )

  /**
   * Use goes through the platform so the Squad records what it came from.
   *
   * `applySquadTemplate` falls back to the direct store writer only when the
   * feature flag is off or the definition genuinely is not in the catalog, and
   * the store actions are handed over for exactly that case.
   */
  const handleUse = useCallback(
    async (template: AgentTeamTemplate, pluginSource?: string) => {
      const result = await applySquadTemplate({
        template,
        ...(pluginSource ? { origin: { pluginSource } } : {}),
        platform: templatePlatform,
        actions: { createTeam, addTeammate, createTask },
        runtime: resolvedRuntime,
      })
      log.info("template_used", {
        templateId: template.id,
        teamId: result.teamId,
        via: result.via,
      })
      router.push(`/squads?id=${encodeURIComponent(result.teamId)}`)
    },
    [addTeammate, createTask, createTeam, resolvedRuntime, router, templatePlatform]
  )

  /**
   * Publish the platform draft this template mirrors.
   *
   * `publish` refuses a bump that does not match its own suggestion, so the
   * suggestion is fetched and shown by the save dialog in `SquadDeriveActions`.
   * Here the gallery is publishing an existing draft rather than a fresh save,
   * and the same rule applies: take the service's suggestion, do not invent a
   * version.
   */
  const handlePublish = useCallback(
    async (template: AgentTeamTemplate) => {
      const status = statuses.byTemplateId[template.id]
      if (!status?.draft) {
        toast.error(t("publishUnavailable"))
        return
      }
      const suggestion = await resolvedRuntime.service.getPublishSuggestion(status.definitionId)
      const published = await resolvedRuntime.service.publish(status.definitionId, {
        expectedRevision: status.draft.revision,
        confirmedBump: suggestion.bump,
      })
      toast.success(t("publishedToast", { name: template.name, version: published.version }))
      statuses.refresh()
    },
    [resolvedRuntime, statuses, t]
  )

  const handleOpenExport = useCallback(
    async (template: AgentTeamTemplate) => {
      const status = statuses.byTemplateId[template.id]
      if (!status || status.state !== "published") {
        toast.error(t("exportUnavailable"))
        return
      }
      const releases = (await resolvedRuntime.repository.listReleases(status.definitionId)).filter(
        (release) => release.version !== null && release.status !== "yanked"
      )
      const origin =
        releases.find((release) => release.version === status.latestVersion) ?? releases[0]
      if (!origin) {
        toast.error(t("exportUnavailable"))
        return
      }
      setExportTarget({ origin, releases })
    },
    [resolvedRuntime, statuses, t]
  )

  const runExport = useCallback(
    async (request: TemplateExportRequest) => {
      const exported = await resolvedRuntime.service.exportPackage(request)
      downloadTemplatePackage(exported.bytes, templatePackageFilename(request.id, request.version))
      setExportTarget(undefined)
    },
    [resolvedRuntime]
  )

  /**
   * Fork lands in the platform library, NOT in this gallery.
   *
   * This panel lists store rows, and `fork` writes a platform draft under a new
   * id with no store row behind it. Saying where it went is the honest answer:
   * the alternative would be a second store write that no longer tracks the
   * lineage `fork` just recorded.
   */
  const handleFork = useCallback(
    async (template: AgentTeamTemplate) => {
      const status = statuses.byTemplateId[template.id]
      if (!status || status.state === "absent") {
        toast.error(t("publishUnavailable"))
        return
      }
      const forked = await resolvedRuntime.service.fork(status.definitionId, {
        ...(status.latestVersion ? { version: status.latestVersion } : {}),
        newId: makeTemplateDraftId("agentTeam", `${template.name} copy`),
      })
      toast.success(t("forkedToast", { id: forked.id }))
      statuses.refresh()
    },
    [resolvedRuntime, statuses, t]
  )

  const inspectImport = useCallback(
    async (file?: File) => {
      if (!file) return
      const bytes = new Uint8Array(await file.arrayBuffer())
      setPendingImport({ bytes, inspected: await resolvedRuntime.service.inspectPackage(bytes) })
      if (importRef.current) importRef.current.value = ""
    },
    [resolvedRuntime]
  )

  const confirmImport = useCallback(async () => {
    if (!pendingImport) return
    await resolvedRuntime.service.importPackage(pendingImport.bytes, {
      source: "file",
      confirmed: true,
    })
    setPendingImport(undefined)
    toast.success(t("importedToast", { count: pendingImport.inspected.definitions.length }))
    statuses.refresh()
  }, [pendingImport, resolvedRuntime, statuses, t])

  /** Run an async action, report what happened, and never leave `busy` stuck. */
  const guard = useCallback(
    (fn: () => Promise<void>) => () => {
      setBusy(true)
      void fn()
        .catch(fail)
        .finally(() => setBusy(false))
    },
    [fail]
  )

  const handleDuplicate = useCallback(
    (source: AgentTeamTemplate) => {
      // Built-ins live in initial-state and are read-only via the store
      // guards; for user templates, the store also accepts a fresh row.
      // Either way, addTemplate is the right call — clone, mint id, force
      // isBuiltIn=false, suffix the name.
      const copy: AgentTeamTemplate = {
        ...source,
        id: nanoid(),
        name: `${source.name} (copy)`,
        teammates: source.teammates.map((tm) => ({ ...tm })),
        isBuiltIn: false,
      }
      addTemplate(copy)
      void publishSquadTemplateToPlatform(copy)
      log.info("template_duplicated", { sourceId: source.id, newId: copy.id })
      toast.success(t("duplicatedToast", { name: copy.name }))
      // Drop straight into the editor so the user can rename / tweak.
      setEditing(copy)
    },
    [addTemplate, t]
  )

  const handleDelete = useCallback(
    (template: AgentTeamTemplate) => {
      if (template.isBuiltIn) return
      deleteTemplate(template.id)
      log.info("template_deleted", { id: template.id })
      toast.success(t("removedToast", { name: template.name }))
    },
    [deleteTemplate, t]
  )

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <Label className="flex items-center gap-2">
            <UsersIcon className="size-4" />
            {t("title")}
          </Label>
          <p className="text-xs text-muted-foreground">{t("description")}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/* The platform's import, with its signature, manifest and size
              checks. The store's `importTemplates` took bare JSON with none of
              them and had no caller at all. */}
          <input
            ref={importRef}
            type="file"
            accept=".cognia-template,application/zip"
            className="hidden"
            data-testid="agent-team-template-import-input"
            onChange={(event) => guard(() => inspectImport(event.target.files?.[0]))()}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => importRef.current?.click()}
            data-testid="agent-team-template-import"
          >
            <UploadIcon className="mr-2 size-4" />
            {t("importPackage")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setEditing(null)
              setCreating(true)
            }}
          >
            <PlusIcon className="mr-2 size-4" />
            {t("newTemplate")}
          </Button>
        </div>
      </div>

      <div className="grid gap-2" data-testid="agent-team-templates-grid">
        {sortedTemplates.merged.map((tpl) => {
          const pluginMeta = sortedTemplates.pluginIndex.get(tpl.id)
          return (
            <TemplateRow
              key={tpl.id}
              template={tpl}
              pluginSource={pluginMeta?.pluginId}
              warnings={pluginMeta?.warnings}
              platformStatus={statuses.byTemplateId[tpl.id]}
              busy={busy}
              onPublish={guard(() => handlePublish(tpl))}
              onExport={guard(() => handleOpenExport(tpl))}
              onFork={guard(() => handleFork(tpl))}
              editing={editing?.id === tpl.id}
              onEditStart={() => setEditing(tpl)}
              onEditCancel={() => setEditing(null)}
              onSave={(patch) => {
                updateTemplate(tpl.id, patch)
                setEditing(null)
                // Keep the unified platform's copy in step. The projection that
                // puts squad templates there otherwise only runs at boot, so an
                // edit made here stayed invisible to Discover, global search and
                // fork until the next restart.
                void publishSquadTemplateToPlatform({ ...tpl, ...patch })
                toast.success(t("updatedToast", { name: patch.name ?? tpl.name }))
              }}
              onUse={guard(() => handleUse(tpl, pluginMeta?.pluginId))}
              onDuplicate={() => handleDuplicate(tpl)}
              onDelete={() => handleDelete(tpl)}
              tCommon={tCommon}
              tShare={tShare}
              t={t}
            />
          )
        })}
      </div>

      {creating && (
        <TemplateEditor
          initial={{
            id: "",
            name: "",
            description: "",
            category: "general",
            teammates: [],
            isBuiltIn: false,
          }}
          submitLabel={t("create")}
          onCancel={() => setCreating(false)}
          onSave={(draft) => {
            const newTemplate: AgentTeamTemplate = {
              ...draft,
              id: nanoid(),
              isBuiltIn: false,
            }
            addTemplate(newTemplate)
            void publishSquadTemplateToPlatform(newTemplate)
            setCreating(false)
            toast.success(t("addedToast", { name: newTemplate.name }))
          }}
        />
      )}

      {/* Reused whole. A package can bundle up to 256 releases, and the Studio
          already has the picker for choosing which. */}
      <TemplateExportDialog
        {...(exportTarget ? { origin: exportTarget.origin } : {})}
        releases={exportTarget?.releases ?? []}
        onOpenChange={(open) => {
          if (!open) setExportTarget(undefined)
        }}
        onExport={(request) => guard(() => runExport(request))()}
      />

      <Dialog
        open={Boolean(pendingImport)}
        onOpenChange={(open) => !open && setPendingImport(undefined)}
      >
        <DialogContent data-testid="agent-team-template-import-dialog">
          <DialogHeader>
            <DialogTitle>{t("importTitle")}</DialogTitle>
            <DialogDescription>{t("importBody")}</DialogDescription>
          </DialogHeader>
          {pendingImport ? (
            <div className="space-y-3 text-sm">
              {/* Only the two trust levels the app cannot vouch for are
                  alarming. A correctly signed package from a publisher this
                  machine trusts is not the same thing as an unsigned one, and
                  showing both the same way is how four trust levels stop
                  meaning anything. */}
              <Alert
                variant={
                  pendingImport.inspected.trust === "unsigned" ||
                  pendingImport.inspected.trust === "signed-unknown"
                    ? "destructive"
                    : "default"
                }
                data-testid="agent-team-template-import-trust"
                data-trust={pendingImport.inspected.trust}
              >
                <AlertTitle>{t(`importTrust.${pendingImport.inspected.trust}`)}</AlertTitle>
                <AlertDescription>{t("importInert")}</AlertDescription>
              </Alert>
              <p>{pendingImport.inspected.manifest.name}</p>
              <p>
                {t("importDefinitionCount", {
                  count: pendingImport.inspected.definitions.length,
                })}
              </p>
              <p className="break-all font-mono text-xs">{pendingImport.inspected.fingerprint}</p>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingImport(undefined)}>
              {tCommon("cancel")}
            </Button>
            <Button
              disabled={busy}
              onClick={guard(confirmImport)}
              data-testid="agent-team-template-import-confirm"
            >
              {t("importConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ---- Row ------------------------------------------------------------------

interface RowProps {
  template: AgentTeamTemplate
  /** Owning plugin id when this template came from `agent-team-template` overlay. */
  pluginSource?: string
  /** Non-blocking dependency warnings stamped by `validateTemplateRequires`. */
  warnings?: readonly PluginAgentTeamTemplateWarning[]
  /** What the unified platform holds for this row. Absent while it loads. */
  platformStatus?: SquadTemplatePlatformStatus
  busy?: boolean
  onPublish: () => void
  onExport: () => void
  onFork: () => void
  editing: boolean
  onEditStart: () => void
  onEditCancel: () => void
  onSave: (patch: Partial<AgentTeamTemplate>) => void
  onUse: () => void
  onDuplicate: () => void
  onDelete: () => void
  t: ReturnType<typeof useTranslations>
  tCommon: ReturnType<typeof useTranslations>
  /** The `share` namespace, so the link action reads like every other one. */
  tShare: ReturnType<typeof useTranslations>
}

function TemplateRow({
  template,
  pluginSource,
  warnings,
  platformStatus,
  busy = false,
  onPublish,
  onExport,
  onFork,
  editing,
  onEditStart,
  onEditCancel,
  onSave,
  onUse,
  onDuplicate,
  onDelete,
  t,
  tCommon,
  tShare,
}: RowProps) {
  // Plugin-sourced templates are read-only (the source of truth lives in
  // the overlay registry). They can still be "used" (instantiates a team)
  // and "duplicated" (clones the projection into a user template) but not
  // edited or deleted. Missing-deps warnings disable the "use" action with
  // a tooltip so operators install the dependency plugin first.
  const isPluginSource = !!pluginSource
  const hasMissingDeps = (warnings?.length ?? 0) > 0
  // Only the user's own rows have a lifecycle to offer. A built-in is a
  // per-boot overlay the app owns, and a plugin row belongs to the registry
  // that contributed it.
  const owned = !template.isBuiltIn && !isPluginSource
  const published = platformStatus?.state === "published"
  // The release a link would carry, or the draft, which the share button turns
  // into "publish a version first" rather than into a missing control.
  const shareDefinition = platformStatus ? squadTemplateShareDefinition(platformStatus) : undefined
  if (editing) {
    return (
      <TemplateEditor
        initial={template}
        submitLabel={t("save")}
        onCancel={onEditCancel}
        onSave={(patch) => onSave(patch)}
      />
    )
  }

  return (
    <Card
      className="p-3"
      data-testid={`agent-team-template-row-${template.id}`}
      data-builtin={template.isBuiltIn ? "true" : "false"}
    >
      <div className="flex items-start gap-3">
        <span
          className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-base"
          aria-hidden
        >
          {template.icon?.charAt(0) ?? template.name.charAt(0).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium">{template.name}</p>
            {template.isBuiltIn && (
              <Badge variant="secondary" className="text-[10px]">
                {t("builtIn")}
              </Badge>
            )}
            {isPluginSource ? (
              <Badge
                variant="outline"
                className="text-[10px]"
                data-testid={`plugin-source-${template.id}`}
              >
                {t("pluginBadge", { plugin: pluginSource ?? "" })}
              </Badge>
            ) : null}
            {hasMissingDeps ? (
              <Badge
                variant="destructive"
                className="text-[10px]"
                title={(warnings ?? []).map((w) => `${w.code}: ${w.missingId}`).join("\n")}
                data-testid={`missing-deps-${template.id}`}
              >
                {t("missingDependencies", { count: warnings?.length ?? 0 })}
              </Badge>
            ) : null}
            <Badge variant="outline" className="text-[10px]">
              {template.category}
            </Badge>
            {/* The row says what the platform holds, because "draft" and
                "v1.2.0" are the difference between a template you can hand to
                someone and one that only exists on this machine. */}
            {owned && platformStatus ? (
              <Badge
                variant={published ? "secondary" : "outline"}
                className="text-[10px]"
                data-testid={`platform-status-${template.id}`}
                data-state={platformStatus.state}
              >
                {published
                  ? t("platformPublished", { version: platformStatus.latestVersion ?? "" })
                  : platformStatus.state === "draft"
                    ? t("platformDraft")
                    : t("platformAbsent")}
              </Badge>
            ) : null}
            {platformStatus?.derivedFrom ? (
              <Badge
                variant="outline"
                className="text-[10px]"
                data-testid={`fork-of-${template.id}`}
              >
                {t("forkOf", { id: platformStatus.derivedFrom.definitionId })}
              </Badge>
            ) : null}
          </div>
          {template.description && (
            <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
              {template.description}
            </p>
          )}
          <p className="mt-1 text-[11px] text-muted-foreground">
            {t("teammateCount", { count: template.teammates.length })}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={onUse}
            disabled={hasMissingDeps}
            aria-label={t("useAria", { name: template.name })}
            title={hasMissingDeps ? t("useDisabledMissingDeps") : t("useTemplate")}
            data-testid={`use-${template.id}`}
          >
            <PlayIcon className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={onEditStart}
            disabled={template.isBuiltIn || isPluginSource}
            title={
              isPluginSource
                ? t("pluginReadOnly")
                : template.isBuiltIn
                  ? t("builtInReadOnly")
                  : t("edit")
            }
            aria-label={t("editAria", { name: template.name })}
            data-testid={`edit-${template.id}`}
          >
            <PencilIcon className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={onDuplicate}
            title={t("duplicate")}
            aria-label={t("duplicateAria", { name: template.name })}
            data-testid={`duplicate-${template.id}`}
          >
            <CopyIcon className="size-3.5" />
          </Button>
          {/* Rendered and disabled rather than hidden on a row that is not
              ready: "this template has no version yet" and "this app cannot
              publish" look identical once the button disappears, and only the
              first is something a person can act on. */}
          {owned ? (
            <>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={onPublish}
                disabled={busy || platformStatus?.state !== "draft"}
                title={platformStatus?.state === "draft" ? t("publish") : t("publishUnavailable")}
                aria-label={t("publishAria", { name: template.name })}
                data-testid={`publish-${template.id}`}
              >
                <UploadCloudIcon className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={onExport}
                disabled={busy || !published}
                title={published ? t("exportPackage") : t("exportUnavailable")}
                aria-label={t("exportAria", { name: template.name })}
                data-testid={`export-${template.id}`}
              >
                <DownloadIcon className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={onFork}
                disabled={busy || !platformStatus || platformStatus.state === "absent"}
                title={
                  platformStatus && platformStatus.state !== "absent"
                    ? t("fork")
                    : t("publishUnavailable")
                }
                aria-label={t("forkAria", { name: template.name })}
                data-testid={`fork-${template.id}`}
              >
                <GitForkIcon className="size-3.5" />
              </Button>
              {/* A link is the third way a squad template leaves this machine,
                  after a package and a fork, and the only one that needs no
                  file. Same component the Studio inspector and Discover use, so
                  a recipient gets the same hash-verifiable envelope from all
                  three. */}
              <div
                className="flex flex-col items-end"
                data-testid={`share-${template.id}`}
                data-state={platformStatus?.state ?? "unknown"}
              >
                {shareDefinition ? (
                  <TemplateDefinitionShareButton definition={shareDefinition} size="sm" />
                ) : (
                  <>
                    <Button type="button" variant="outline" size="sm" disabled>
                      <Link2Icon className="size-4" />
                      {tShare("shareAction")}
                    </Button>
                    <p
                      className="mt-1 text-xs text-muted-foreground"
                      data-testid={`share-unavailable-${template.id}`}
                    >
                      {t("shareUnavailable")}
                    </p>
                  </>
                )}
              </div>
            </>
          ) : null}
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-destructive hover:text-destructive"
                disabled={template.isBuiltIn || isPluginSource}
                title={
                  isPluginSource
                    ? t("pluginReadOnly")
                    : template.isBuiltIn
                      ? t("builtInReadOnly")
                      : tCommon("delete")
                }
                aria-label={t("deleteAria", { name: template.name })}
                data-testid={`delete-${template.id}`}
              >
                <Trash2Icon className="size-3.5" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t("removeTitle")}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t("removeBody", { name: template.name })}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
                <AlertDialogAction onClick={onDelete}>{tCommon("delete")}</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>
    </Card>
  )
}

// ---- Inline editor --------------------------------------------------------

interface EditorProps {
  initial: AgentTeamTemplate
  submitLabel: string
  onCancel: () => void
  onSave: (template: AgentTeamTemplate) => void
}

function TemplateEditor({ initial, submitLabel, onCancel, onSave }: EditorProps) {
  const t = useTranslations("settings.agentTeams")
  const tCommon = useTranslations("common")
  const [draft, setDraft] = useState<AgentTeamTemplate>(initial)

  const submit = () => {
    if (!draft.name.trim()) {
      toast.error(t("nameRequired"))
      return
    }
    onSave({ ...draft, name: draft.name.trim() })
  }

  return (
    <Card className="space-y-3 p-4" data-testid="agent-team-template-editor">
      <div className="space-y-1">
        <Label className="text-xs">{t("editorName")}</Label>
        <Input
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          placeholder={t("editorNamePlaceholder")}
          data-testid="editor-name"
        />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">{t("editorDescription")}</Label>
        <Textarea
          rows={3}
          value={draft.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          className="text-xs"
          placeholder={t("editorDescriptionPlaceholder")}
        />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">{t("editorCategory")}</Label>
        <Select
          value={draft.category}
          onValueChange={(v) =>
            setDraft({ ...draft, category: v as AgentTeamTemplate["category"] })
          }
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CATEGORIES.map((c) => (
              <SelectItem key={c} value={c}>
                {c}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <p className="text-[11px] text-muted-foreground">
        {t("teammateEditNote", { count: draft.teammates.length })}
      </p>
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {tCommon("cancel")}
        </Button>
        <Button size="sm" onClick={submit} data-testid="editor-submit">
          {submitLabel}
        </Button>
      </div>
    </Card>
  )
}

export default AgentTeamTemplatesSection
