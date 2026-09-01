"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import {
  ArrowUpCircleIcon,
  FolderDownIcon,
  FolderIcon,
  LayoutTemplateIcon,
  LinkIcon,
  MoreHorizontalIcon,
  PackageIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  SparklesIcon,
  UploadIcon,
} from "lucide-react"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { VideoIcon } from "lucide-react"
import { openRecorder } from "@/stores/skills/recorder-store"
import { useRecorderAvailable } from "@/hooks/skills/use-skill-recorder"
import { SkillDiscovery } from "./skill-discovery"
import { SkillTemplateDialog } from "./skill-template-dialog"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useSettingsStore } from "@/stores/settings"
import { resolveSkillBundleMirrors } from "@/stores/settings/settings-store"
import { pickAndReadBinaryFiles, pickAndReadFiles, pickDirectory } from "@/lib/files/file-bridge"
import { isTauri } from "@/lib/tauri"
import { canReadHostSkills, canWriteHostSkills } from "@/lib/skills/sync"
import { loadBundle, type BundleResult } from "@/lib/skills/bundle/loader"
import { listSkills } from "@/lib/db/skills"
import { nameFromFilename, parseSkillMarkdown } from "@/lib/claude/skills-io"
import { scanClaudeSkills, skillsEmptyTrash, skillsListTrash } from "@/lib/claude/ipc"
import { useSkillsStore } from "@/stores/skills"
import type { ImportStaging } from "@/stores/skills"
import { useSkillSync, useSkillUpdate } from "@/hooks/skills"
import { exportSkillsToDirWithFeedback } from "@/lib/skills/export-toast"
import { loggers } from "@cognia/logging"

const SKILL_FILE_FILTERS = [{ name: "Markdown", extensions: ["md", "markdown"] }]
const BUNDLE_FILE_FILTERS = [{ name: "Skill bundle", extensions: ["zip"] }]

function slug(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "skill"
  )
}

function toBundleImportDraft(
  result: BundleResult,
  source: "zip" | "folder",
  nativeDirectory?: string
): ImportStaging["drafts"][number] {
  const draft = result.draft
  return {
    name: draft.name,
    slug: draft.slug,
    description: draft.description,
    compatibility: draft.compatibility,
    metadata: draft.metadata,
    invocationPolicy: draft.invocationPolicy,
    frontmatterExtensions: draft.frontmatterExtensions,
    codexOpenAiYaml: draft.codexOpenAiYaml,
    content: draft.content,
    tags: draft.tags,
    allowedTools: draft.allowedTools,
    category: draft.category,
    canonicalId: `bundle:${source}:${draft.slug ?? slug(draft.name)}`,
    resources: result.resources,
    validationErrors:
      result.nonFatalValidationErrors.length > 0 ? result.nonFatalValidationErrors : undefined,
    ...(nativeDirectory ? { nativeDirectory } : {}),
  }
}

export function SkillPanelToolbar() {
  const t = useTranslations("skills.toolbar")
  const tRecorder = useTranslations("skills.recorder")
  const recorderAvailable = useRecorderAvailable()
  const tCommon = useTranslations("skills")
  const tToasts = useTranslations("skills.toasts")
  const tSync = useTranslations("skills.sync")
  const tDiscovery = useTranslations("skills.discovery")
  const [busy, setBusy] = useState(false)
  const [discoveryOpen, setDiscoveryOpen] = useState(false)
  const [templateOpen, setTemplateOpen] = useState(false)
  const openCreate = useSkillsStore((s) => s.openCreate)
  const setImportStaging = useSkillsStore((s) => s.setImportStaging)
  const setUrlInstallOpen = useSkillsStore((s) => s.setUrlInstallOpen)
  const sync = useSkillSync()
  /**
   * Whether the *host* can serve its skills directory, which is not the same
   * question as whether this shell is Tauri. `skills_scan_native`,
   * `skills_install_native`, `skills_catalog_get` and the atomic-install family
   * are all `transports: ["http","websocket","webrtc"]`, and `lib/claude/ipc.ts`
   * already routes them through the transport, so a browser or phone driving a
   * paired Host can sync that Host's `~/.claude/skills/`. Gating on `isTauri()`
   * told those clients the feature did not exist. `useSkillSync` has always
   * checked the real predicates before acting; only these `disabled` flags lied.
   */
  const hostSkillsReachable = canReadHostSkills() || canWriteHostSkills()
  const updates = useSkillUpdate()
  // Select the raw field so Zustand's referential equality holds across
  // renders — wrapping `resolveSkillBundleMirrors` in the selector creates
  // a fresh object every read and triggers an update loop in React 19.
  const rawMirrors = useSettingsStore((s) => s.settings?.skillBundleMirrors)
  const mirrorSettings = resolveSkillBundleMirrors(
    rawMirrors ? ({ skillBundleMirrors: rawMirrors } as never) : null
  )
  const setMirror = useSettingsStore((s) => s.setSkillBundleMirrors)
  const [trashCount, setTrashCount] = useState(0)

  // Refresh the trash badge on mount. Tauri-only — outside Tauri the listing
  // call is a no-op error. setTrashCount runs only after the awaited IPC call,
  // so it never fires synchronously during the effect commit.
  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    void (async () => {
      try {
        const entries = await skillsListTrash()
        if (!cancelled) setTrashCount(entries.length)
      } catch {
        if (!cancelled) setTrashCount(0)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const handleEmptyTrash = async () => {
    if (!isTauri()) return
    setBusy(true)
    try {
      const removed = await skillsEmptyTrash()
      setTrashCount(0)
      toast.success(tSync("trashEmptied", { count: removed }))
      loggers.skills.info("trash emptied", { removed })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
      loggers.skills.error("empty trash failed", err)
    } finally {
      setBusy(false)
    }
  }

  const handleImportFromMarkdown = async () => {
    setBusy(true)
    try {
      const files = await pickAndReadFiles({
        filters: SKILL_FILE_FILTERS,
        multiple: true,
      })
      if (files.length === 0) return
      const drafts: ImportStaging["drafts"] = []
      const parseErrors: ImportStaging["parseErrors"] = []
      for (const file of files) {
        try {
          const fallback = nameFromFilename(file.name)
          const { draft, portabilityIssues } = parseSkillMarkdown(file.content, {
            fallbackName: fallback,
          })
          drafts.push({
            ...draft,
            validationErrors: portabilityIssues.length > 0 ? portabilityIssues : undefined,
          })
        } catch (err) {
          parseErrors.push({
            name: file.name,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      if (drafts.length === 0) {
        toast.error(
          parseErrors.length > 0
            ? tToasts("importNoFilesParsed", { count: parseErrors.length })
            : tToasts("importNoSkills")
        )
        loggers.skills.warn("import.markdown none parsed", {
          attempted: files.length,
          errors: parseErrors.length,
        })
        return
      }
      setImportStaging({
        drafts,
        sourceLabel: `${files.length} markdown file(s)`,
        parseErrors,
      })
      loggers.skills.info("import.markdown staged", {
        drafts: drafts.length,
        errors: parseErrors.length,
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
      loggers.skills.error("import.markdown failed", err)
    } finally {
      setBusy(false)
    }
  }

  const handleImportFromBundleZip = async () => {
    setBusy(true)
    try {
      const files = await pickAndReadBinaryFiles({
        filters: BUNDLE_FILE_FILTERS,
        multiple: false,
      })
      if (files.length === 0) return
      const picked = files[0]
      const fallback = picked.name.replace(/\.zip$/i, "")
      const result = await loadBundle({
        kind: "zip-blob",
        bytes: picked.bytes,
        fallbackName: fallback,
      })
      const draft = toBundleImportDraft(result, "zip")
      setImportStaging({
        drafts: [draft],
        sourceLabel: picked.name,
        parseErrors: [],
        flavor: result.flavor,
      })
      loggers.skills.info("import.bundleZip staged", {
        name: result.draft.name,
        flavor: result.flavor,
        resources: result.resources.length,
        warnings: result.warnings.length,
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
      loggers.skills.error("import.bundleZip failed", err)
    } finally {
      setBusy(false)
    }
  }

  const handleImportFromBundleFolder = async () => {
    if (!isTauri()) {
      toast.error(tToasts("importFromClaudeDesktopOnly"))
      return
    }
    setBusy(true)
    try {
      const dir = await pickDirectory()
      if (!dir) return
      const fallback =
        dir
          .replace(/\\/g, "/")
          .split("/")
          .filter((s) => s.length > 0)
          .pop() ?? "skill"
      const result = await loadBundle({
        kind: "folder",
        path: dir,
        fallbackName: fallback,
      })
      const draft = toBundleImportDraft(result, "folder", dir)
      setImportStaging({
        drafts: [draft],
        sourceLabel: dir,
        parseErrors: [],
        flavor: result.flavor,
      })
      loggers.skills.info("import.bundleFolder staged", {
        name: result.draft.name,
        flavor: result.flavor,
        resources: result.resources.length,
        warnings: result.warnings.length,
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
      loggers.skills.error("import.bundleFolder failed", err)
    } finally {
      setBusy(false)
    }
  }

  const handleImportFromClaudeCode = async () => {
    if (!isTauri()) {
      toast.error(tToasts("importFromClaudeDesktopOnly"))
      return
    }
    setBusy(true)
    try {
      const discovered = await scanClaudeSkills()
      if (discovered.length === 0) {
        toast.info(tToasts("importNoSkillMd"))
        loggers.skills.info("import.claudeCode empty")
        return
      }
      const drafts: ImportStaging["drafts"] = []
      const parseErrors: ImportStaging["parseErrors"] = []
      for (const file of discovered) {
        try {
          const { draft, portabilityIssues } = parseSkillMarkdown(file.content, {
            fallbackName: file.dirName,
          })
          const tags = Array.from(new Set([...(draft.tags ?? []), "claude-code"]))
          drafts.push({
            ...draft,
            tags,
            validationErrors: portabilityIssues.length > 0 ? portabilityIssues : undefined,
          })
        } catch (err) {
          parseErrors.push({
            name: file.dirName,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      if (drafts.length === 0) {
        toast.error(
          tToasts("importNoneParsed", {
            found: discovered.length,
            first: parseErrors[0]?.error ?? "",
          })
        )
        loggers.skills.warn("import.claudeCode none parsed", {
          found: discovered.length,
          errors: parseErrors.length,
        })
        return
      }
      setImportStaging({
        drafts,
        sourceLabel: "~/.claude/skills/",
        parseErrors,
      })
      loggers.skills.info("import.claudeCode staged", {
        drafts: drafts.length,
        errors: parseErrors.length,
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
      loggers.skills.error("import.claudeCode failed", err)
    } finally {
      setBusy(false)
    }
  }

  const handleCheckUpdates = async () => {
    try {
      const count = await updates.checkAll()
      if (count > 0) toast.success(tToasts("updatesFound", { count }))
      else toast.info(tToasts("updatesNone"))
      loggers.skills.info("update check done", { updates: count })
    } catch (err) {
      toast.error(
        tToasts("updatesError", { error: err instanceof Error ? err.message : String(err) })
      )
      loggers.skills.error("update check failed", err)
    }
  }

  const handleExportAll = async () => {
    setBusy(true)
    try {
      const all = await listSkills()
      const customSkills = all.filter((s) => !s.isBuiltIn)
      await exportSkillsToDirWithFeedback(customSkills, tToasts, {
        source: "exportAll",
        total: customSkills.length,
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
      loggers.skills.error("export all failed", err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Button size="sm" onClick={() => openCreate()} disabled={busy}>
        <PlusIcon className="size-3.5 sm:mr-1.5" />
        <span className="hidden sm:inline">{t("new")}</span>
      </Button>
      {/* Gated on the owning plugin rather than on `isTauri()`: disabling the
          Skill Recorder must take every entry point with it, and the plugin is
          the thing that holds the native grants. */}
      {recorderAvailable ? (
        <Button size="sm" variant="outline" onClick={() => openRecorder("toolbar")} disabled={busy}>
          <VideoIcon className="size-3.5 sm:mr-1.5" />
          <span className="hidden sm:inline">{tRecorder("entry.toolbarButton")}</span>
        </Button>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline" disabled={busy}>
            <UploadIcon className="size-3.5 sm:mr-1.5" />
            <span className="hidden sm:inline">{t("import")}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuGroup>
            <DropdownMenuItem onSelect={() => setTemplateOpen(true)} className="text-xs">
              <LayoutTemplateIcon className="mr-2 size-3.5" />
              <div className="flex flex-col gap-0.5">
                <span>{tCommon("templates.fromTemplate")}</span>
                <span className="text-[10px] text-muted-foreground">
                  {tCommon("templates.fromTemplateHint")}
                </span>
              </div>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void handleImportFromMarkdown()} className="text-xs">
              <UploadIcon className="mr-2 size-3.5" />
              <div className="flex flex-col gap-0.5">
                <span>{t("importFromMarkdown")}</span>
                <span className="text-[10px] text-muted-foreground">
                  {t("importFromMarkdownHint")}
                </span>
              </div>
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => void handleImportFromBundleZip()}
              className="text-xs"
              data-testid="skill-panel-toolbar-import-bundle-zip"
            >
              <PackageIcon className="mr-2 size-3.5" />
              <div className="flex flex-col gap-0.5">
                <span>{t("importFromBundle")}</span>
                <span className="text-[10px] text-muted-foreground">
                  {t("importFromBundleHint")}
                </span>
              </div>
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => void handleImportFromBundleFolder()}
              disabled={!isTauri()}
              className="text-xs"
              data-testid="skill-panel-toolbar-import-bundle-folder"
            >
              <FolderIcon className="mr-2 size-3.5" />
              <div className="flex flex-col gap-0.5">
                <span>{t("importFromBundleFolder")}</span>
                <span className="text-[10px] text-muted-foreground">
                  {t("importFromBundleFolderHint")}
                </span>
              </div>
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => void handleImportFromClaudeCode()}
              disabled={!isTauri()}
              className="text-xs"
            >
              <SparklesIcon className="mr-2 size-3.5" />
              <div className="flex flex-col gap-0.5">
                <span>{t("importFromClaudeCode")}</span>
                <span className="text-[10px] text-muted-foreground">
                  {t("importFromClaudeCodeHint")}
                </span>
              </div>
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => setDiscoveryOpen(true)}
              disabled={!isTauri()}
              className="text-xs"
            >
              <SearchIcon className="mr-2 size-3.5" />
              <div className="flex flex-col gap-0.5">
                <span>{tDiscovery("title")}</span>
                <span className="text-[10px] text-muted-foreground">
                  {tDiscovery("scanCustom")}
                </span>
              </div>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => setUrlInstallOpen(true)}
              className="text-xs"
              data-testid="skill-panel-toolbar-install-from-url"
            >
              <LinkIcon className="mr-2 size-3.5" />
              <div className="flex flex-col gap-0.5">
                <span>{t("installFromUrl")}</span>
                <span className="text-[10px] text-muted-foreground">
                  {tCommon("marketplace.urlInstall.description")}
                </span>
              </div>
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Export + Updates + Sync visible inline at md+ */}
      <Button
        size="sm"
        variant="outline"
        onClick={() => void handleExportAll()}
        disabled={busy}
        className="hidden md:inline-flex"
      >
        <FolderDownIcon className="mr-1.5 size-3.5" />
        {t("exportAll")}
      </Button>
      <Button
        size="sm"
        variant="outline"
        onClick={() => void handleCheckUpdates()}
        disabled={busy || updates.checking}
        className="hidden md:inline-flex"
        data-testid="skill-panel-toolbar-check-updates"
      >
        <ArrowUpCircleIcon className="mr-1.5 size-3.5" />
        {updates.checking ? t("checkingUpdates") : t("checkUpdates")}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="ghost"
            disabled={!hostSkillsReachable || busy || sync.busy}
            title={hostSkillsReachable ? t("syncNative") : tSync("unavailableRead")}
            className="hidden md:inline-flex"
          >
            <RefreshCwIcon className="mr-1.5 size-3.5" />
            {tCommon("syncLabel")}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuGroup>
            <DropdownMenuItem onSelect={() => void sync.push()} className="text-xs">
              <RefreshCwIcon className="mr-2 size-3.5" />
              {tSync("pushAll")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void sync.pull()} className="text-xs">
              <RefreshCwIcon className="mr-2 size-3.5 -scale-x-100" />
              {tSync("pullAll")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {tSync("mirrorTargetsLabel")}
            </DropdownMenuLabel>
            <DropdownMenuCheckboxItem
              checked={mirrorSettings.claude}
              onCheckedChange={(v) => void setMirror({ claude: !!v })}
              className="text-xs"
              data-testid="skill-panel-toolbar-mirror-claude"
            >
              {tSync("mirrorClaude")}
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={mirrorSettings.codex}
              onCheckedChange={(v) => void setMirror({ codex: !!v })}
              className="text-xs"
              data-testid="skill-panel-toolbar-mirror-codex"
            >
              {tSync("mirrorCodex")}
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => void handleEmptyTrash()}
              disabled={!isTauri() || trashCount === 0 || busy}
              className="text-xs"
              data-testid="skill-panel-toolbar-empty-trash"
            >
              <FolderDownIcon className="mr-2 size-3.5" />
              <span>{tSync("emptyTrash", { count: trashCount })}</span>
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Below md, Export + Sync collapse into a single overflow menu. */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="icon"
            variant="ghost"
            className="size-8 md:hidden"
            disabled={busy}
            aria-label={t("moreActions")}
          >
            <MoreHorizontalIcon className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuGroup>
            <DropdownMenuItem
              onSelect={() => void handleExportAll()}
              disabled={busy}
              className="text-xs"
            >
              <FolderDownIcon className="mr-2 size-3.5" />
              {t("exportAll")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => void handleCheckUpdates()}
              disabled={busy || updates.checking}
              className="text-xs"
            >
              <ArrowUpCircleIcon className="mr-2 size-3.5" />
              {updates.checking ? t("checkingUpdates") : t("checkUpdates")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => void sync.push()}
              disabled={!canWriteHostSkills() || sync.busy}
              className="text-xs"
            >
              <RefreshCwIcon className="mr-2 size-3.5" />
              {tSync("pushAll")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => void sync.pull()}
              disabled={!canReadHostSkills() || sync.busy}
              className="text-xs"
            >
              <RefreshCwIcon className="mr-2 size-3.5 -scale-x-100" />
              {tSync("pullAll")}
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <SkillTemplateDialog open={templateOpen} onOpenChange={setTemplateOpen} />

      <Sheet open={discoveryOpen} onOpenChange={setDiscoveryOpen}>
        <SheetContent side="right" className="w-full p-0 sm:max-w-xl">
          <SheetHeader className="border-b px-5 py-3">
            <SheetTitle>{tDiscovery("title")}</SheetTitle>
            <SheetDescription>
              {tDiscovery("scanHome")} · {tDiscovery("scanCustom")}
            </SheetDescription>
          </SheetHeader>
          <SkillDiscovery />
        </SheetContent>
      </Sheet>
    </div>
  )
}
