"use client"

// The template library: a searchable rail of saved messages on the left, the
// selected template's actual content — with live fill-in slots — on the right.
//
// The previous layout was a column of action cards that hid the one thing a
// template IS (the message) behind an Edit button. This one puts the body in
// the detail pane with its `{{tokens}}` rendered as clickable chips, filled
// through the same `TemplateParamPopover` the composer opens — so the page
// teaches the real interaction instead of describing it in copy.
//
// Editing the body re-derives the parameter declarations from it, keeping any
// label or requirement someone took the trouble to write (`deriveParams`), and
// bumps the template's revision. Renaming does not: a draft records the
// revision it quoted, so bumping over a cosmetic edit would make every open
// draft claim to be out of date.
//
// This is also the only place a parameter's TYPE can be set. The composer
// derives every token as required free text, which is right for a phrase you
// typed once. Turning one into a workspace-file reference or a closed list of
// choices is a decision about a template you intend to reuse, and it belongs
// next to the body it describes rather than in a popover you are trying to
// type past.
//
// ## Portability
//
// The table is device-local (it has no `lib/sync` handler yet), so the only way
// a template reaches another machine is as a file. Export, import and "save to
// repository" therefore all speak ONE format: the `.cognia/templates/*.md`
// document `parseRepoTemplate` already reads. There is no private export
// dialect, so anything exported here can be committed, reviewed, and read back
// by the composer on somebody else's clone.
//
// Imported and repository-sourced setups go through `demoteRepoLaunchSpec` on
// the way in, exactly like a file found in a checkout. A `.md` the user picked
// off disk arrived from somewhere too, and a permission mode is not something a
// file gets to raise.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import {
  CopyIcon,
  DownloadIcon,
  FileCode2Icon,
  FileUpIcon,
  GitBranchIcon,
  MoreHorizontalIcon,
  PlusIcon,
  SearchIcon,
  SendIcon,
  SlashSquareIcon,
  Trash2Icon,
} from "lucide-react"
import { toast } from "sonner"
import { downloadBlob } from "@cognia/plugin-sdk/api/download"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  SettingsListDetail,
  useSettingsListDensity,
} from "@/components/settings/common/settings-master-detail"
import {
  createChatTemplate,
  deleteChatTemplate,
  listChatTemplates,
  type ChatTemplateRow,
} from "@/lib/db/chat-templates"
import { seedParamValues, templateSlug } from "@/lib/chat/template/template"
import { isParamFilled, type ChatTemplateParamValue } from "@/lib/chat/template/binding"
import { listParamTokens } from "@/lib/chat/template/param-segments"
import { computeCodeRanges } from "@/lib/chat/template/code-ranges"
import { renderParamTokens } from "@/lib/chat/template/render-params"
import { createSession } from "@/lib/db/sessions"
import { setDraft } from "@/lib/db/chat-drafts"
import { useChatStore } from "@/stores/chat"
import type { ChatTemplateLaunchSpec } from "@/lib/chat/template/launch-spec"
import {
  REPO_TEMPLATE_DIR,
  REPO_TEMPLATE_MAX_BYTES,
  parseRepoTemplate,
  serializeChatTemplate,
  type RepoChatTemplate,
} from "@/lib/chat/template/repo-templates"
import { saveChatTemplateToRepository } from "@/lib/chat/template/repo-template-write"
import { loadRepoChatTemplates } from "@/hooks/chat/use-repo-chat-templates"
import { useTemplateResourceSearch } from "@/hooks/chat/use-template-resource-search"
import { useMentionableSubagents } from "@/hooks/chat/use-mentionable-subagents"
import { useMarkdownChatAgents } from "@/hooks/chat/use-markdown-chat-agents"
import { ChatTemplateShareButton } from "@/components/share/chat-template-share-button"
import { TemplateParamPopover } from "@/components/chat/composer/template-param-popover"
import { ChatTemplateBodyPreview } from "./chat-templates/body-preview"
import { ChatTemplateEditor } from "./chat-templates/template-editor"
import { cn } from "@/lib/utils"

export interface ChatTemplatesSectionProps {
  /** When true, switch to the single-column mobile layout. */
  mobile?: boolean
}

/** A row in the rail: a personal template or a repository one. */
type ListedTemplate =
  { source: "personal"; row: ChatTemplateRow } | { source: "repo"; row: RepoChatTemplate }

/**
 * Which directory "save to repository" writes into.
 *
 * The same chain a send resolves (`resolveEffectiveCwdForSession`), asked with
 * no session: active workspace primary root, then the app default. Imported
 * dynamically so a settings panel does not pull the execution-context and
 * character resolvers into its static graph, and so a build where that chain
 * cannot resolve degrades to "no repository" instead of a blank section.
 */
async function resolveWorkspaceRoot(): Promise<string | null> {
  const { resolveEffectiveCwdForSession } = await import("@/hooks/chat/use-effective-cwd")
  return resolveEffectiveCwdForSession(null)
}

/**
 * Read a picked file as text.
 *
 * `FileReader` rather than `Blob.text()`: the three shells this ships in are
 * three different webviews, and this is the reader every one of them has had
 * for a decade. It is also the one jsdom implements, so the import path is
 * exercised by a test rather than only in a browser.
 */
function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error("unreadable"))
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "")
    reader.readAsText(file)
  })
}

/** "plan mode · claude-opus-4-6" — the suggestion a launch spec carries, in one line. */
function launchSpecSummary(spec: ChatTemplateLaunchSpec | undefined): string | null {
  if (!spec) return null
  const parts: string[] = []
  if (spec.agentModeId) parts.push(`${spec.agentModeId} mode`)
  if (spec.model) parts.push(spec.model)
  if (spec.characterId) parts.push(`as ${spec.characterId}`)
  if (spec.squadId) parts.push(`squad ${spec.squadId}`)
  if (spec.workingDir) parts.push(spec.workingDir)
  if (spec.permissionMode) parts.push(`${spec.permissionMode} permissions`)
  if (spec.effort) parts.push(`${spec.effort} effort`)
  return parts.length > 0 ? parts.join(" · ") : null
}

export function ChatTemplatesSection({ mobile = false }: ChatTemplatesSectionProps) {
  const t = useTranslations("chatTemplatesSettings")
  const [rows, setRows] = useState<ChatTemplateRow[]>([])
  const [repoRows, setRepoRows] = useState<RepoChatTemplate[]>([])
  const [root, setRoot] = useState<string | null>(null)
  const [epoch, setEpoch] = useState(0)
  const [query, setQuery] = useState("")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState(false)
  /** The write that is waiting on "yes, replace the file that is already there". */
  const [overwriting, setOverwriting] = useState<{ row: ChatTemplateRow; path: string } | null>(
    null
  )
  /** The delete that is waiting on confirmation — the row is gone for good. */
  const [deleting, setDeleting] = useState<ChatTemplateRow | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Rehearsal state for the detail preview — the same fill-in interaction the
  // composer performs, against seeded defaults + last-used values.
  const [tryValues, setTryValues] = useState<Record<string, ChatTemplateParamValue>>({})
  const [seededFor, setSeededFor] = useState<string | null>(null)
  const [filling, setFilling] = useState<string | null>(null)
  const [previewBox, setPreviewBox] = useState<HTMLDivElement | null>(null)
  const router = useRouter()

  // The picker's sources: workspace files under the same root repo writes use,
  // and the mentionable subagents. Team-room sources (mentionables, members)
  // have no context on a settings page — the hook treats them as empty rather
  // than absent, exactly like a composer outside a team room.
  const mentionableSubagents = useMentionableSubagents()
  const markdownAgents = useMarkdownChatAgents(root, true)
  const chatAgents = useMemo(() => {
    if (markdownAgents.length === 0) return mentionableSubagents
    const seen = new Set(mentionableSubagents.map((target) => target.id))
    return [...mentionableSubagents, ...markdownAgents.filter((a) => !seen.has(a.id))]
  }, [mentionableSubagents, markdownAgents])
  const searchResources = useTemplateResourceSearch({ cwd: root, chatAgents })

  // Same "no evidence either way" rule the composer applies: an empty source
  // list means this surface cannot judge, not that the target is gone.
  const isResourceResolvable = useCallback(
    (value: Extract<ChatTemplateParamValue, { kind: "resource" }>) => {
      if (value.resourceKind === "subagent") {
        return chatAgents.length === 0 || chatAgents.some((a) => a.handle === value.id)
      }
      return true
    },
    [chatAgents]
  )

  useEffect(() => {
    let cancelled = false
    listChatTemplates()
      .then((next) => {
        if (!cancelled) setRows(next)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [epoch])

  useEffect(() => {
    let cancelled = false
    resolveWorkspaceRoot()
      .then((next) => {
        if (!cancelled) setRoot(next)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  // Repository templates are read under the same Workspace Trust verdict the
  // composer applies, by the same loader. An untrusted checkout contributes
  // nothing here either.
  useEffect(() => {
    let cancelled = false
    loadRepoChatTemplates(root)
      .then((next) => {
        if (!cancelled) setRepoRows(next)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [root, epoch])

  const reload = useCallback(() => setEpoch((n) => n + 1), [])

  const remove = useCallback(
    async (row: ChatTemplateRow) => {
      await deleteChatTemplate(row.id)
      // The deleted row may be the one in the editor — leaving `editing` set
      // would drop the NEXT selected row into edit mode for no reason.
      setEditing(false)
      toast.success(t("deleted", { name: row.name }))
      reload()
    },
    [reload, t]
  )

  const duplicate = useCallback(
    async (row: ChatTemplateRow) => {
      // A copy is a NEW template, not a revision of the old one: fresh id, no
      // usage history, and the revision counter back at its baseline, so a
      // draft holding the original's revision is not accidentally satisfied by
      // the copy.
      await createChatTemplate({
        name: t("duplicatedName", { name: row.name }),
        ...(row.description ? { description: row.description } : {}),
        body: row.body,
        params: row.params,
        ...(row.launchSpec ? { launchSpec: row.launchSpec } : {}),
      })
      toast.success(t("duplicated", { name: row.name }))
      reload()
    },
    [reload, t]
  )

  const exportOne = useCallback((row: ChatTemplateRow) => {
    downloadBlob(
      `${templateSlug(row.name)}.md`,
      new Blob([serializeChatTemplate(row)], { type: "text/markdown" })
    )
  }, [])

  const importFile = useCallback(
    async (file: File) => {
      const text = (await readFileText(file)).slice(0, REPO_TEMPLATE_MAX_BYTES)
      const parsed = parseRepoTemplate(file.name, text)
      if (!parsed) {
        toast.error(t("importFailed"))
        return
      }
      // `createChatTemplate` mints the id. The `repo:`-prefixed one the parser
      // produced names a FILE, and reusing it would collide with the checkout's
      // own template the moment one is opened.
      await createChatTemplate({
        name: parsed.name,
        ...(parsed.description ? { description: parsed.description } : {}),
        body: parsed.body,
        params: parsed.params,
        ...(parsed.launchSpec ? { launchSpec: parsed.launchSpec } : {}),
      })
      toast.success(t("imported", { name: parsed.name }))
      reload()
    },
    [reload, t]
  )

  const saveToRepo = useCallback(
    async (row: ChatTemplateRow, overwrite = false) => {
      const outcome = await saveChatTemplateToRepository(root, row, { overwrite })
      if (outcome.ok) {
        toast.success(t("savedToRepo", { path: outcome.path }))
        setOverwriting(null)
        reload()
        return
      }
      if (outcome.reason === "exists") {
        setOverwriting({ row, path: outcome.path })
        return
      }
      setOverwriting(null)
      toast.error(
        outcome.reason === "restricted"
          ? t("saveToRepoRestricted")
          : outcome.reason === "no-root"
            ? t("saveToRepoNoRoot")
            : t("saveToRepoFailed", { path: outcome.path })
      )
    },
    [reload, root, t]
  )

  /**
   * The rehearsal values, filtered to parameters the body still declares.
   * tryValues is reseeded per selection+revision, so this is the composed
   * answer set — the same thing a draft's binding would hold after the user
   * finished filling the composer chips.
   */
  const rehearsalBindingParams = useCallback(
    (row: { params: { id: string }[] }) => {
      const declared = new Set(row.params.map((param) => param.id))
      return Object.fromEntries(Object.entries(tryValues).filter(([id]) => declared.has(id)))
    },
    [tryValues]
  )

  // The detail pane's terminal actions: hand the rehearsed message to the
  // composer as a real draft, or put it on the clipboard. Both carry the
  // values the user just filled in — copying `{{module}}` verbatim would be
  // exporting the question, not the answer.
  const copyMessage = useCallback(
    async (row: ListedTemplate["row"]) => {
      const rendered = renderParamTokens(
        row.body,
        listParamTokens(row.body, computeCodeRanges(row.body)),
        {
          templateId: row.id,
          version: String(row.revision),
          params: rehearsalBindingParams(row),
          insertedAt: Date.now(),
        }
      )
      try {
        await navigator.clipboard.writeText(rendered.text)
        toast.success(t("copied"))
      } catch {
        toast.error(t("copyFailed"))
      }
    },
    [rehearsalBindingParams, t]
  )

  const openInChat = useCallback(
    async (row: ListedTemplate["row"]) => {
      try {
        const session = await createSession()
        await setDraft(session.id, row.body, [], {
          templateBinding: {
            templateId: row.id,
            version: String(row.revision),
            params: rehearsalBindingParams(row),
            insertedAt: Date.now(),
          },
        })
        useChatStore.getState().setActiveSession(session.id)
        router.push("/")
      } catch {
        toast.error(t("useInChatFailed"))
      }
    },
    [rehearsalBindingParams, router, t]
  )

  const adopt = useCallback(
    async (row: RepoChatTemplate) => {
      // The launch spec was already demoted on the way out of the file, and the
      // demoted one is what gets copied. Adopting a repository template must
      // not be a way to launder a setup the trust gate refused.
      await createChatTemplate({
        name: row.name,
        ...(row.description ? { description: row.description } : {}),
        body: row.body,
        params: row.params,
        ...(row.launchSpec ? { launchSpec: row.launchSpec } : {}),
      })
      toast.success(t("adopted", { name: row.name }))
      reload()
    },
    [reload, t]
  )

  // ---- Derived view state ------------------------------------------------

  const items: ListedTemplate[] = [
    ...rows.map((row): ListedTemplate => ({ source: "personal", row })),
    ...repoRows.map((row): ListedTemplate => ({ source: "repo", row })),
  ]
  const q = query.trim().toLowerCase()
  const filtered = q
    ? items.filter(
        ({ row }) =>
          row.name.toLowerCase().includes(q) ||
          row.body.toLowerCase().includes(q) ||
          (row.description ?? "").toLowerCase().includes(q)
      )
    : items
  const personalItems = filtered.filter((i) => i.source === "personal")
  const repoItems = filtered.filter((i) => i.source === "repo")
  const selected = items.find((i) => i.row.id === selectedId) ?? filtered[0] ?? null

  // Re-seed the rehearsal values when the selection — or the template's own
  // content — changes: last-used values first, then declared defaults, exactly
  // like the composer does on insert. Keyed on revision so saving an edit
  // drops stale values for parameters the new body no longer has.
  // Both row kinds carry a revision (a counter for personal rows, a content
  // hash for repository ones), so the key doubles for both.
  const seedKey = selected ? `${selected.row.id}@${selected.row.revision}` : null
  if (selected && seedKey && seededFor !== seedKey) {
    setSeededFor(seedKey)
    setTryValues(
      seedParamValues(
        selected.row.params,
        selected.source === "personal" ? selected.row.lastParams : undefined
      )
    )
    setFilling(null)
  }

  const missing = selected
    ? selected.row.params.filter((param) => param.required && !isParamFilled(tryValues[param.id]))
        .length
    : 0

  const select = (item: ListedTemplate) => {
    setSelectedId(item.row.id)
    setEditing(false)
    setCreating(false)
    setFilling(null)
  }

  // The rail in two pieces: the stacked tier keeps the header and swaps the
  // scroll list for the picker, which is why they are separate expressions
  // rather than one fragment (a fragment is not Array-checkable).
  const railHeader = (
    <div className="shrink-0 space-y-2 border-b p-2">
      <div className="relative">
        <SearchIcon className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("searchPlaceholder")}
          aria-label={t("searchPlaceholder")}
          className="h-8 pl-8 text-xs"
        />
      </div>
      <div className="flex gap-1.5">
        <Button
          size="sm"
          className="h-7 flex-1 gap-1 px-2 text-[11px]"
          onClick={() => {
            setCreating(true)
            setEditing(false)
          }}
        >
          <PlusIcon className="size-3.5" />
          {t("newTemplate")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1 px-2 text-[11px]"
          onClick={() => fileInputRef.current?.click()}
        >
          <FileUpIcon className="size-3.5" />
          {t("importAction")}
        </Button>
      </div>
    </div>
  )
  const railList = (
    <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
      <TemplateGroup
        title={t("mineHeading")}
        items={personalItems}
        selectedId={selected?.row.id ?? null}
        onSelect={select}
      />
      {repoItems.length > 0 ? (
        <div data-testid="repo-chat-templates">
          <TemplateGroup
            title={t("repoHeading")}
            badge={t("repoReadOnly")}
            items={repoItems}
            selectedId={selected?.row.id ?? null}
            onSelect={select}
          />
        </div>
      ) : null}
      {filtered.length === 0 ? (
        <p className="p-3 text-xs text-muted-foreground">
          {query ? t("noMatches") : t("emptyRail")}
        </p>
      ) : null}
    </div>
  )

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="chat-templates-section">
      <input
        ref={fileInputRef}
        type="file"
        accept=".md,.mdx,text/markdown"
        className="hidden"
        aria-label={t("importAction")}
        onChange={(event) => {
          const file = event.target.files?.[0]
          // Cleared so picking the SAME file twice fires a change event the
          // second time. Without it a failed import cannot be retried.
          event.target.value = ""
          if (file) void importFile(file)
        }}
      />

      <SettingsListDetail listWidth={280} className="min-h-0 flex-1">
        <RailWrapper
          railHeader={railHeader}
          railList={railList}
          items={filtered}
          selectedId={selected?.row.id ?? null}
          onSelect={select}
          chooseLabel={t("chooseTemplate")}
        />

        <section className="flex min-h-0 flex-col overflow-hidden rounded-lg border bg-card">
          {creating ? (
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <div className="mx-auto max-w-2xl">
                <h3 className="mb-1 text-sm font-semibold">{t("newTemplateTitle")}</h3>
                <p className="mb-4 text-xs text-muted-foreground">{t("newTemplateHint")}</p>
                <ChatTemplateEditor
                  mobile={mobile}
                  onCancel={() => setCreating(false)}
                  onSaved={(row) => {
                    setCreating(false)
                    reload()
                    setSelectedId(row.id)
                  }}
                />
              </div>
            </div>
          ) : selected ? (
            <>
              <header className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    {selected.source === "repo" ? (
                      <GitBranchIcon className="size-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <FileCode2Icon className="size-4 shrink-0 text-muted-foreground" />
                    )}
                    <h3 className="truncate text-sm font-semibold">{selected.row.name}</h3>
                    {selected.source === "repo" ? (
                      <Badge variant="outline" className="gap-1 text-[10px]">
                        {t("repoReadOnly")}
                      </Badge>
                    ) : null}
                  </div>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {selected.row.description ??
                      (selected.source === "repo" ? selected.row.sourcePath : "")}
                  </p>
                  {launchSpecSummary(selected.row.launchSpec) ? (
                    <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                      {t("suggestsSetup", {
                        summary: launchSpecSummary(selected.row.launchSpec) ?? "",
                      })}
                    </p>
                  ) : null}
                </div>
                <DetailActions
                  item={selected}
                  onUseInChat={() => void openInChat(selected.row)}
                  onCopy={() => void copyMessage(selected.row)}
                  onEdit={() => {
                    setFilling(null)
                    setEditing(true)
                  }}
                  onAdopt={() => selected.source === "repo" && void adopt(selected.row)}
                  onDuplicate={() => selected.source === "personal" && void duplicate(selected.row)}
                  onExport={() => selected.source === "personal" && exportOne(selected.row)}
                  onSaveToRepo={() =>
                    selected.source === "personal" && void saveToRepo(selected.row)
                  }
                  onDelete={() => selected.source === "personal" && setDeleting(selected.row)}
                />
              </header>
              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                {editing && selected.source === "personal" ? (
                  <div className="mx-auto max-w-2xl">
                    <ChatTemplateEditor
                      key={selected.row.id}
                      row={selected.row}
                      mobile={mobile}
                      onCancel={() => setEditing(false)}
                      onSaved={() => {
                        setEditing(false)
                        reload()
                      }}
                    />
                  </div>
                ) : (
                  <div className="mx-auto max-w-2xl space-y-5">
                    <div>
                      <div className="mb-1.5 flex items-center justify-between">
                        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                          {t("messagePreview")}
                        </p>
                        <Badge
                          variant="outline"
                          className={cn(
                            "text-[10px]",
                            missing === 0
                              ? "border-emerald-500/40 text-emerald-600"
                              : "border-amber-500/40 text-amber-600"
                          )}
                        >
                          {missing === 0 ? t("readyToSend") : t("requiredLeft", { count: missing })}
                        </Badge>
                      </div>
                      <div ref={setPreviewBox}>
                        <ChatTemplateBodyPreview
                          body={selected.row.body}
                          values={tryValues}
                          onParamClick={(id) => setFilling(id)}
                          isResolvable={isResourceResolvable}
                        />
                      </div>
                      {selected.row.params.length > 0 ? (
                        <p className="mt-2 text-[11px] text-muted-foreground">
                          {t("clickSlotHint")}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex items-center justify-between gap-3 rounded-md bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <SlashSquareIcon className="size-3.5 shrink-0" />
                        <span className="truncate">
                          {t("useHint", { name: selected.row.name })}
                        </span>
                      </span>
                      <span className="shrink-0 tabular-nums">
                        {selected.source === "repo"
                          ? selected.row.sourcePath
                          : t("used", { count: selected.row.usageCount })}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
              <FileCode2Icon className="size-8 text-muted-foreground/50" />
              <div className="max-w-md space-y-1">
                <p className="text-sm font-medium">{t("emptyTitle")}</p>
                <p className="text-xs text-muted-foreground">{t("empty")}</p>
              </div>
              <div className="flex gap-2">
                <Button size="sm" className="gap-1" onClick={() => setCreating(true)}>
                  <PlusIcon className="size-3.5" />
                  {t("emptyCreate")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <FileUpIcon className="size-3.5" />
                  {t("importAction")}
                </Button>
              </div>
            </div>
          )}
        </section>
      </SettingsListDetail>

      {/*
        The two portability facts, said out loud once rather than per card:
        imported files get the same launch-spec demotion a checkout gets, and
        repository templates are files — edited with an editor, reviewed in a
        pull request, and only offered in workspaces the user trusts.
      */}
      <p className="shrink-0 px-1 pt-2 text-[11px] text-muted-foreground">
        {t("repoHint", { path: REPO_TEMPLATE_DIR + "/*.md" })}
      </p>

      {/* The composer's own chip editor, anchored to the preview box. */}
      <TemplateParamPopover
        paramId={filling}
        param={selected?.row.params.find((p) => p.id === filling) ?? null}
        value={filling ? tryValues[filling] : undefined}
        anchor={filling ? previewBox : null}
        searchResources={searchResources}
        position={(() => {
          if (!filling || !selected) return undefined
          const index = selected.row.params.findIndex((p) => p.id === filling)
          // A token the saved declarations no longer carry still opens the
          // popover — it just does not get a "2 of 4" counter.
          return index >= 0 ? { index, total: selected.row.params.length } : undefined
        })()}
        onChange={(value) => {
          if (filling) setTryValues((values) => ({ ...values, [filling]: value }))
        }}
        onClose={() => setFilling(null)}
      />

      <AlertDialog
        open={overwriting !== null}
        onOpenChange={(open) => !open && setOverwriting(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("overwriteTitle", { path: overwriting?.path ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t("overwriteBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (overwriting) void saveToRepo(overwriting.row, true)
              }}
            >
              {t("overwriteConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteTitle", { name: deleting?.name ?? "" })}</AlertDialogTitle>
            <AlertDialogDescription>{t("deleteBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleting) void remove(deleting)
                setDeleting(null)
              }}
            >
              {t("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/**
 * At the split tier the rail is a bordered column. At the stacked tier
 * (<560px pane) the grid's first row is `auto`, so the scrollable list would
 * eat the pane — it collapses to the pinned header plus a compact picker for
 * the detail below, the same job the Sheet trigger does in
 * SettingsMasterDetail for nav rails.
 */
function RailWrapper({
  railHeader,
  railList,
  items,
  selectedId,
  onSelect,
  chooseLabel,
}: {
  railHeader: ReactNode
  railList: ReactNode
  items: ListedTemplate[]
  selectedId: string | null
  onSelect(item: ListedTemplate): void
  chooseLabel: string
}) {
  const density = useSettingsListDensity()
  if (density === "stacked") {
    return (
      <div className="space-y-2 rounded-lg border">
        {/* The rail's pinned header only — the scroll list is replaced by the
            picker so the auto-height row stays small. */}
        {railHeader}
        {/* A picker with nothing in it is a dead control; the empty detail
            pane below already offers New and Import. */}
        {items.length === 0 ? null : (
          <div className="border-t p-2" data-testid="chat-templates-stacked-picker">
            <Select
              value={selectedId ?? ""}
              onValueChange={(id) => {
                const next = items.find((i) => i.row.id === id)
                if (next) onSelect(next)
              }}
            >
              <SelectTrigger className="h-8 text-xs" aria-label={chooseLabel}>
                <SelectValue placeholder={chooseLabel} />
              </SelectTrigger>
              <SelectContent>
                {items.map((i) => (
                  <SelectItem key={i.row.id} value={i.row.id} className="text-xs">
                    {i.row.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>
    )
  }
  return (
    <aside className="flex min-h-0 flex-col overflow-hidden rounded-lg border">
      {railHeader}
      {railList}
    </aside>
  )
}

function TemplateGroup({
  title,
  badge,
  items,
  selectedId,
  onSelect,
}: {
  title: string
  badge?: string
  items: ListedTemplate[]
  selectedId: string | null
  onSelect(item: ListedTemplate): void
}) {
  if (items.length === 0) return null
  return (
    <div className="pt-1.5">
      <div className="flex items-center gap-2 px-2 pb-1">
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {title}
        </span>
        {badge ? (
          <Badge variant="outline" className="h-4 px-1 text-[9px]">
            {badge}
          </Badge>
        ) : null}
      </div>
      {items.map((item) => (
        <button
          key={item.row.id}
          type="button"
          onClick={() => onSelect(item)}
          className={cn(
            "flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-accent",
            selectedId === item.row.id && "bg-accent"
          )}
        >
          <span className="truncate text-xs font-medium">{item.row.name}</span>
          <span className="truncate font-mono text-[10px] text-muted-foreground">
            {item.row.body.split("\n")[0]}
          </span>
        </button>
      ))}
    </div>
  )
}

function DetailActions({
  item,
  onUseInChat,
  onCopy,
  onEdit,
  onAdopt,
  onDuplicate,
  onExport,
  onSaveToRepo,
  onDelete,
}: {
  item: ListedTemplate
  onUseInChat(): void
  onCopy(): void
  onEdit(): void
  onAdopt(): void
  onDuplicate(): void
  onExport(): void
  onSaveToRepo(): void
  onDelete(): void
}) {
  const t = useTranslations("chatTemplatesSettings")
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <Button size="sm" className="h-8 gap-1 text-xs" onClick={onUseInChat}>
        <SendIcon className="size-3.5" />
        {t("useInChat")}
      </Button>
      {item.source === "repo" ? (
        <Button size="sm" variant="outline" className="h-8 gap-1 text-xs" onClick={onAdopt}>
          <CopyIcon className="size-3.5" />
          {t("adopt")}
        </Button>
      ) : (
        <>
          <Button size="sm" variant="outline" className="h-8 text-xs" onClick={onEdit}>
            {t("edit")}
          </Button>
          <ChatTemplateShareButton template={item.row} size="sm" className="h-8 text-xs" />
        </>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-8" aria-label={t("moreActions")}>
            <MoreHorizontalIcon className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={onCopy}>
            <CopyIcon className="size-3.5" />
            {t("copyMessage")}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={item.source === "repo"} onClick={onDuplicate}>
            <CopyIcon className="size-3.5" />
            {t("duplicate")}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={item.source === "repo"} onClick={onExport}>
            <DownloadIcon className="size-3.5" />
            {t("exportAction")}
          </DropdownMenuItem>
          {item.source === "personal" ? (
            <DropdownMenuItem onClick={onSaveToRepo}>
              <GitBranchIcon className="size-3.5" />
              {t("saveToRepo")}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-destructive"
            disabled={item.source === "repo"}
            onClick={onDelete}
          >
            <Trash2Icon className="size-3.5" />
            {t("delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
