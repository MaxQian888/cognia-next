"use client"

/**
 * Settings → Authoring → Prompts: the Prompt Center (ADR-0236).
 *
 * One list over every prompt resource. Code-owned slots are edited here with
 * drafts, scoped overrides, history and reset; every other resource keeps its
 * owner (a character, preset, Skill, mode, instruction file, workspace record,
 * the default system prompt, a chat template) and is edited through that
 * owner's own write path, with "Open in …" to its full screen. The workspace
 * whose instruction files and record are listed is chosen here explicitly and
 * defaults to the active one; it never follows the chat on screen.
 */

import { useMemo, useState, type ReactNode } from "react"
import {
  AlertTriangleIcon,
  ArrowLeftRightIcon,
  EyeIcon,
  FileCode2Icon,
  SearchIcon,
} from "lucide-react"
import { Surface } from "@/components/surface/surface"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import {
  SettingsListDetail,
  useSettingsListDensity,
} from "@/components/settings/common/settings-master-detail"
import { usePromptResourceContext } from "@/hooks/prompts/use-prompt-resource-context"
import { usePromptResources } from "@/hooks/prompts/use-prompt-resources"
import { getPromptDefinition } from "@/lib/prompts/catalog"
import type { PromptResourceSource, PromptResourceSummary } from "@/lib/prompts/resources"
import type { PromptGroup } from "@/lib/prompts/types"
import { cn } from "@/lib/utils"
import { useProjectStore } from "@/stores/project/project-store"
import { CodePromptDetail } from "./code-prompt-detail"
import { EffectivePreviewPanel } from "./effective-preview-panel"
import { OwnerPromptDetail } from "./owner-prompt-detail"
import { PromptProfileDialog } from "./prompt-profile-dialog"
import { UnavailablePromptDetail } from "./unavailable-prompt-detail"
import { usePromptLabels, type PromptLabels } from "./use-prompt-labels"

/** Rail key of the pinned effective preview. */
export const PREVIEW_KEY = "preview"
const ALL = "all"
const NO_WORKSPACE = "__none__"

const SOURCE_ORDER: readonly PromptResourceSource[] = [
  "app-setting",
  "instruction-file",
  "workspace-instructions",
  "character",
  "custom-mode",
  "preset",
  "skill",
  "subagent-template",
  "team-template",
  "composer-template",
  "code",
]

const GROUP_ORDER: readonly PromptGroup[] = [
  "chat",
  "agents",
  "generation",
  "completion",
  "goals",
  "team",
  "knowledge",
  "developer",
  "twin",
  "permissions",
  "routing",
]

interface RailGroup {
  id: string
  title: string
  items: PromptResourceSummary[]
}

function titleOf(labels: PromptLabels, resource: PromptResourceSummary): string {
  if (resource.promptId) return labels.entryTitle(resource.promptId)
  if (resource.source === "app-setting") return labels.t("owner.defaultSystemPrompt")
  return resource.name ?? resource.key
}

function matches(labels: PromptLabels, resource: PromptResourceSummary, query: string): boolean {
  if (!query) return true
  const haystack = [titleOf(labels, resource), resource.key, resource.name, resource.detail]
  if (resource.promptId) {
    haystack.push(labels.entryDescription(resource.promptId))
    // Shipped bodies are bundled, so searching them costs no read.
    haystack.push(getPromptDefinition(resource.promptId)?.defaultBody)
  }
  return haystack.some((value) => value?.toLowerCase().includes(query))
}

export function PromptsSection() {
  const labels = usePromptLabels()
  const { t } = labels
  const activeProjectId = useProjectStore((state) => state.activeProjectId)
  const projects = useProjectStore((state) => state.projects)
  const [workspaceChoice, setWorkspaceChoice] = useState<string | null | undefined>(undefined)
  const workspaceId = workspaceChoice === undefined ? activeProjectId : workspaceChoice
  const ctx = usePromptResourceContext(workspaceId)
  const { state, reload } = usePromptResources(ctx)
  const listing = state.listing

  const [query, setQuery] = useState("")
  const [source, setSource] = useState<string>(ALL)
  const [group, setGroup] = useState<string>(ALL)
  const [modifiedOnly, setModifiedOnly] = useState(false)
  const [selectedKey, setSelectedKey] = useState<string>(PREVIEW_KEY)
  const [profileOpen, setProfileOpen] = useState(false)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (listing?.resources ?? []).filter(
      (resource) =>
        (source === ALL || resource.source === source) &&
        (group === ALL || resource.group === group) &&
        (!modifiedOnly || resource.modified) &&
        matches(labels, resource, q)
    )
  }, [group, labels, listing, modifiedOnly, query, source])

  const groups = useMemo<RailGroup[]>(() => {
    const out: RailGroup[] = []
    for (const owner of SOURCE_ORDER) {
      if (owner === "code") {
        for (const codeGroup of GROUP_ORDER) {
          const items = filtered.filter(
            (resource) => resource.source === "code" && resource.group === codeGroup
          )
          if (items.length > 0)
            out.push({ id: `code:${codeGroup}`, title: t(`group.${codeGroup}`), items })
        }
        continue
      }
      const items = filtered.filter((resource) => resource.source === owner)
      if (items.length > 0) out.push({ id: owner, title: t(`sourceGroup.${owner}`), items })
    }
    const unavailable = filtered.filter((resource) => resource.unavailable)
    if (unavailable.length > 0) {
      out.push({ id: "unavailable", title: t("rail.unavailable"), items: unavailable })
    }
    return out
  }, [filtered, t])

  const selected =
    selectedKey === PREVIEW_KEY
      ? undefined
      : listing?.resources.find((resource) => resource.key === selectedKey)
  const total = listing?.resources.length ?? 0
  const modifiedCount = listing?.resources.filter((resource) => resource.modified).length ?? 0

  const railHeader = (
    <div className="shrink-0 space-y-2 border-b p-2">
      <div className="relative">
        <SearchIcon className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("rail.search")}
          aria-label={t("rail.search")}
          className="h-8 pl-8 text-xs"
        />
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        <Select value={source} onValueChange={setSource}>
          <SelectTrigger className="h-7 text-[11px]" aria-label={t("rail.sourceFilter")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL} className="text-xs">
              {t("rail.allSources")}
            </SelectItem>
            {SOURCE_ORDER.map((candidate) => (
              <SelectItem key={candidate} value={candidate} className="text-xs">
                {t(`sourceGroup.${candidate}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={group} onValueChange={setGroup}>
          <SelectTrigger className="h-7 text-[11px]" aria-label={t("rail.groupFilter")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL} className="text-xs">
              {t("rail.allGroups")}
            </SelectItem>
            {GROUP_ORDER.map((candidate) => (
              <SelectItem key={candidate} value={candidate} className="text-xs">
                {t(`group.${candidate}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Select
        value={workspaceId ?? NO_WORKSPACE}
        onValueChange={(next) => setWorkspaceChoice(next === NO_WORKSPACE ? null : next)}
      >
        <SelectTrigger className="h-7 text-[11px]" aria-label={t("rail.workspace")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_WORKSPACE} className="text-xs">
            {t("rail.noWorkspace")}
          </SelectItem>
          {projects
            .filter((project) => !project.isArchived)
            .map((project) => (
              <SelectItem key={project.id} value={project.id} className="text-xs">
                {project.name}
              </SelectItem>
            ))}
        </SelectContent>
      </Select>
      <div className="flex items-center justify-between gap-2">
        <Label className="flex items-center gap-2 text-[11px] font-normal">
          <Switch
            checked={modifiedOnly}
            onCheckedChange={setModifiedOnly}
            aria-label={t("rail.modifiedOnly")}
          />
          {t("rail.modifiedOnly")}
        </Label>
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1 px-2 text-[11px]"
          onClick={() => setProfileOpen(true)}
        >
          <ArrowLeftRightIcon className="size-3.5" />
          {t("rail.profiles")}
        </Button>
      </div>
      <p className="text-[10px] text-muted-foreground" data-testid="prompt-center-count">
        {t("rail.count", { total, modified: modifiedCount })}
      </p>
    </div>
  )

  const railList = (
    <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
      <RailButton
        active={selectedKey === PREVIEW_KEY}
        onClick={() => setSelectedKey(PREVIEW_KEY)}
        icon={<EyeIcon className="size-3.5 shrink-0 text-muted-foreground" />}
        title={t("preview.title")}
        subtitle={t("preview.railHint")}
      />
      {listing?.failed.length ? (
        <p className="mx-2 my-1.5 flex items-start gap-1.5 text-[11px] text-destructive">
          <AlertTriangleIcon className="mt-0.5 size-3 shrink-0" />
          {t("rail.failed", {
            sources: listing.failed.map((failed) => t(`sourceGroup.${failed}`)).join(", "),
          })}
        </p>
      ) : null}
      {state.status === "error" ? (
        <p className="mx-2 my-1.5 text-[11px] text-destructive">
          {t("rail.loadFailed", { message: state.error })}
        </p>
      ) : null}
      {state.status === "loading" && !listing ? (
        <p className="p-3 text-xs text-muted-foreground">{t("rail.loading")}</p>
      ) : null}
      {groups.map((railGroup) => (
        <div key={railGroup.id} className="pt-2">
          <p className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {railGroup.title}
          </p>
          {railGroup.items.map((resource) => (
            <RailButton
              key={resource.key}
              active={selectedKey === resource.key}
              onClick={() => setSelectedKey(resource.key)}
              title={titleOf(labels, resource)}
              subtitle={resource.promptId ?? resource.detail}
              mono={Boolean(resource.promptId)}
              badges={
                <>
                  {resource.modified ? (
                    <span
                      className="size-1.5 shrink-0 rounded-full bg-primary"
                      title={t("rail.modified")}
                      aria-label={t("rail.modified")}
                    />
                  ) : null}
                  {resource.edit === "owner-only" ? (
                    <Badge variant="outline" className="h-4 px-1 text-[9px]">
                      {t("rail.readOnly")}
                    </Badge>
                  ) : null}
                </>
              }
            />
          ))}
        </div>
      ))}
      {listing && filtered.length === 0 ? (
        <p className="p-3 text-xs text-muted-foreground">{t("rail.noMatches")}</p>
      ) : null}
    </div>
  )

  const def = selected?.promptId ? getPromptDefinition(selected.promptId) : undefined

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="prompts-section">
      <SettingsListDetail listWidth={300} className="min-h-0 flex-1">
        <RailWrapper
          header={railHeader}
          list={railList}
          options={[
            { key: PREVIEW_KEY, title: t("preview.title") },
            ...filtered.map((resource) => ({
              key: resource.key,
              title: titleOf(labels, resource),
            })),
          ]}
          selectedKey={selectedKey}
          onSelect={setSelectedKey}
          chooseLabel={t("rail.choose")}
        />
        <Surface asChild>
          <section className="flex min-h-0 flex-col overflow-hidden rounded-lg border bg-card">
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <div className="mx-auto max-w-3xl">
                {selectedKey === PREVIEW_KEY ? (
                  <EffectivePreviewPanel workspaceId={workspaceId ?? null} />
                ) : def ? (
                  <CodePromptDetail key={def.id} def={def} />
                ) : selected?.unavailable && selected.promptId ? (
                  <UnavailablePromptDetail key={selected.key} promptId={selected.promptId} />
                ) : selected ? (
                  <OwnerPromptDetail
                    key={selected.key}
                    resource={selected}
                    ctx={ctx}
                    onChanged={reload}
                    onSelect={setSelectedKey}
                  />
                ) : (
                  <div className="flex flex-col items-center gap-2 py-16 text-center text-xs text-muted-foreground">
                    <FileCode2Icon className="size-8 opacity-50" />
                    {state.status === "loading" ? t("rail.loading") : t("detail.missing")}
                  </div>
                )}
              </div>
            </div>
          </section>
        </Surface>
      </SettingsListDetail>
      <PromptProfileDialog open={profileOpen} onOpenChange={setProfileOpen} />
    </div>
  )
}

function RailButton({
  active,
  onClick,
  title,
  subtitle,
  icon,
  badges,
  mono = false,
}: {
  active: boolean
  onClick(): void
  title: string
  subtitle?: string
  icon?: ReactNode
  badges?: ReactNode
  mono?: boolean
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={onClick}
      aria-current={active}
      className={cn(
        "flex h-auto w-full items-start gap-2 whitespace-normal rounded-md px-2 py-1.5 text-left hover:bg-accent",
        active && "bg-accent"
      )}
    >
      {icon}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-xs font-medium">{title}</span>
          {badges}
        </span>
        {subtitle ? (
          <span className={cn("truncate text-[10px] text-muted-foreground", mono && "font-mono")}>
            {subtitle}
          </span>
        ) : null}
      </span>
    </Button>
  )
}

/**
 * The split tier shows the rail as a column; the stacked tier keeps the
 * header and replaces the long list with a picker, as the chat templates
 * section does, so the detail stays on screen.
 */
function RailWrapper({
  header,
  list,
  options,
  selectedKey,
  onSelect,
  chooseLabel,
}: {
  header: ReactNode
  list: ReactNode
  options: { key: string; title: string }[]
  selectedKey: string
  onSelect(key: string): void
  chooseLabel: string
}) {
  const density = useSettingsListDensity()
  if (density === "stacked") {
    return (
      <div className="space-y-2 rounded-lg border">
        {header}
        <div className="border-t p-2" data-testid="prompts-stacked-picker">
          <Select value={selectedKey} onValueChange={onSelect}>
            <SelectTrigger className="h-8 text-xs" aria-label={chooseLabel}>
              <SelectValue placeholder={chooseLabel} />
            </SelectTrigger>
            <SelectContent>
              {options.map((option) => (
                <SelectItem key={option.key} value={option.key} className="text-xs">
                  {option.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    )
  }
  return (
    <aside className="flex min-h-0 flex-col overflow-hidden rounded-lg border">
      {header}
      {list}
    </aside>
  )
}
