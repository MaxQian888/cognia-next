"use client"

/**
 * Bind a resource to a delivery container.
 *
 * Four kinds (spec 2026-09-06 D1, D10, D11):
 *
 *   - `github-repo`    in `mirror` mode the ADR-0132 read-only rows, in
 *                      `import` mode local issues kept in step both ways, with
 *                      an optional Projects v2 number for iterations.
 *   - `lark-tasklist`  a Feishu/Lark tasklist through a connected Lark
 *                      account, tasks in and out, sections as cycles.
 *   - `lark-bitable`   one table of a Bitable app, column by column.
 *   - `workspace-root` a directory the workspace has ALREADY mounted. This
 *                      dialog never mounts one (`lib/workspace/trust-gate.ts`
 *                      is the only way in).
 *
 * Adding the first synced resource anywhere creates the background refresh
 * task, and removing the last one deletes it
 * (`lib/issues/github-sync-schedule.ts`).
 *
 * The Lark pickers read the remote through `withLarkAuthedApi`, so they work
 * only on the desktop host (open.feishu.cn sends no CORS headers). The error
 * they surface names the account so a missing grant reads as "reconnect this
 * account", not "sync broke".
 */

import { useEffect, useMemo, useState } from "react"
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
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { withLarkAuthedApi } from "@/lib/connectors/adapters/lark/authed-api"
import { listAdapterInstancesByType } from "@/lib/db/adapter-instances"
import { addIssueProjectResource } from "@/lib/db/issue-projects"
import { syncGithubIssueSchedule } from "@/lib/issues/github-sync-schedule"
import { isSyncedResource } from "@/lib/issues/sync/bindings"
import {
  listBitableFields,
  listBitableTables,
  listLarkTasklists,
  type BitableFieldSummary,
  type BitableTableSummary,
  type LarkTasklistSummary,
} from "@/lib/issues/sync/providers/lark-api"
import { parseLarkResourceUrl } from "@/lib/twin/ingest/lark-url"
import type { IssueProjectResource, IssueStatus, LarkBitableFieldMap } from "@/types/issues"
import { ISSUE_STATUSES } from "@/types/issues"
import type { WorkspaceRoot } from "@/types/workspace"

/** `owner/name`, the only form the GitHub API accepts for a repo path. */
export const REPO_FULL_NAME_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/

export type ResourceKind = IssueProjectResource["kind"]

/** The Bitable columns the map can name, beyond the required title. */
const OPTIONAL_BITABLE_FIELDS = [
  "description",
  "status",
  "priority",
  "assignee",
  "dueDate",
  "estimate",
] as const

type OptionalBitableField = (typeof OPTIONAL_BITABLE_FIELDS)[number]

/** `Select` cannot hold an empty string, so "not mapped" gets a sentinel. */
const NO_FIELD = "__none__"

/** A pasted Bitable URL or a bare token, reduced to the app token. */
export function parseBitableAppToken(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  const parsed = parseLarkResourceUrl(trimmed)
  if (parsed?.kind === "bitable") return parsed.token
  return /^[A-Za-z0-9]+$/.test(trimmed) ? trimmed : null
}

interface LarkAccountOption {
  id: string
  label: string
}

export interface ProjectResourceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Container to bind to. */
  issueProjectId: string
  /** Directories the workspace has already mounted, the only ones offerable. */
  roots: readonly WorkspaceRoot[]
  /** Repos already bound anywhere, so a second binding can be refused up front. */
  boundRepos?: ReadonlySet<string>
  /** Root ids already referenced by THIS container. */
  boundRootIds?: ReadonlySet<string>
  onAdded?: (resource: IssueProjectResource) => void
}

export function ProjectResourceDialog({
  open,
  onOpenChange,
  issueProjectId,
  roots,
  boundRepos,
  boundRootIds,
  onAdded,
}: ProjectResourceDialogProps) {
  const t = useTranslations("issues")

  const [kind, setKind] = useState<ResourceKind>("github-repo")
  const [repo, setRepo] = useState("")
  const [syncMode, setSyncMode] = useState<"mirror" | "import">("mirror")
  const [projectV2, setProjectV2] = useState("")
  const [rootId, setRootId] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Lark: the connected accounts, and what the pickers loaded from them.
  const [accounts, setAccounts] = useState<LarkAccountOption[]>([])
  const [accountId, setAccountId] = useState("")
  const [tasklists, setTasklists] = useState<LarkTasklistSummary[] | null>(null)
  const [tasklistGuid, setTasklistGuid] = useState("")
  const [bitableInput, setBitableInput] = useState("")
  const [tables, setTables] = useState<BitableTableSummary[] | null>(null)
  const [tableId, setTableId] = useState("")
  const [fields, setFields] = useState<BitableFieldSummary[] | null>(null)
  const [fieldMap, setFieldMap] = useState<Record<string, string>>({})
  const [statusValues, setStatusValues] = useState<Partial<Record<IssueStatus, string>>>({})
  const [loading, setLoading] = useState(false)

  const needsLark = kind === "lark-tasklist" || kind === "lark-bitable"
  useEffect(() => {
    if (!open || !needsLark) return
    let cancelled = false
    void listAdapterInstancesByType("lark").then((rows) => {
      if (cancelled) return
      const options = rows
        .filter((row) => row.enabled)
        .map((row) => {
          const connected = (row.settings as { connectedUser?: { name?: string } } | undefined)
            ?.connectedUser
          return {
            id: row.id,
            label: connected?.name ? `${row.displayName} · ${connected.name}` : row.displayName,
          }
        })
      setAccounts(options)
    })
    return () => {
      cancelled = true
    }
  }, [open, needsLark])

  const availableRoots = useMemo(
    () => roots.filter((root) => !boundRootIds?.has(root.id)),
    [roots, boundRootIds]
  )

  /**
   * Cleared on the way out rather than by an effect watching `open`: an effect
   * that calls setState is a cascading render, and routing every close path,
   * cancel, Escape, overlay click, successful submit, through `close()` keeps
   * the draft from outliving the dialog without one.
   */
  function close() {
    setRepo("")
    setSyncMode("mirror")
    setProjectV2("")
    setRootId("")
    setAccountId("")
    setTasklists(null)
    setTasklistGuid("")
    setBitableInput("")
    setTables(null)
    setTableId("")
    setFields(null)
    setFieldMap({})
    setStatusValues({})
    setError(null)
    onOpenChange(false)
  }

  const trimmedRepo = repo.trim()
  const repoInvalid = trimmedRepo.length > 0 && !REPO_FULL_NAME_PATTERN.test(trimmedRepo)
  const repoTaken = boundRepos?.has(trimmedRepo) ?? false
  const projectV2Number = projectV2.trim() ? Number(projectV2.trim()) : undefined
  const projectV2Invalid =
    projectV2Number !== undefined && (!Number.isInteger(projectV2Number) || projectV2Number <= 0)
  const selectedRootId = rootId || (availableRoots[0]?.id ?? "")
  const selectedAccountId = accountId || (accounts[0]?.id ?? "")
  const appToken = parseBitableAppToken(bitableInput)
  const bitableInvalid = bitableInput.trim().length > 0 && appToken === null
  const selectedTasklist = tasklists?.find((row) => row.guid === tasklistGuid)
  const selectedTable = tables?.find((row) => row.tableId === tableId)

  const canSubmit =
    !busy &&
    !loading &&
    (kind === "github-repo"
      ? trimmedRepo.length > 0 && !repoInvalid && !repoTaken && !projectV2Invalid
      : kind === "workspace-root"
        ? selectedRootId.length > 0
        : kind === "lark-tasklist"
          ? Boolean(selectedAccountId && selectedTasklist)
          : Boolean(selectedAccountId && appToken && selectedTable && fieldMap.title))

  async function loadWith<T>(run: () => Promise<T>, apply: (value: T) => void) {
    setLoading(true)
    setError(null)
    try {
      apply(await run())
    } catch (cause) {
      setError(describeLarkError(cause, t))
    } finally {
      setLoading(false)
    }
  }

  function loadTasklists() {
    if (!selectedAccountId) return
    void loadWith(
      () => withLarkAuthedApi({ adapterId: selectedAccountId }, (api) => listLarkTasklists(api)),
      (rows) => {
        setTasklists(rows)
        setTasklistGuid(rows[0]?.guid ?? "")
      }
    )
  }

  function loadTables() {
    if (!selectedAccountId || !appToken) return
    void loadWith(
      () =>
        withLarkAuthedApi({ adapterId: selectedAccountId }, (api) =>
          listBitableTables(api, appToken)
        ),
      (rows) => {
        setTables(rows)
        setTableId(rows[0]?.tableId ?? "")
        setFields(null)
        setFieldMap({})
      }
    )
  }

  function loadFields() {
    if (!selectedAccountId || !appToken || !tableId) return
    void loadWith(
      () =>
        withLarkAuthedApi({ adapterId: selectedAccountId }, (api) =>
          listBitableFields(api, appToken, tableId)
        ),
      (rows) => {
        setFields(rows)
        // A column literally named like the field is the obvious default.
        const guess: Record<string, string> = {}
        for (const name of ["title", ...OPTIONAL_BITABLE_FIELDS]) {
          const hit = rows.find((row) => row.name.toLowerCase() === name.toLowerCase())
          if (hit) guess[name] = hit.name
        }
        if (!guess.title && rows[0]) guess.title = rows[0].name
        setFieldMap(guess)
      }
    )
  }

  function buildResource(): IssueProjectResource {
    const addedAt = Date.now()
    switch (kind) {
      case "github-repo":
        return {
          kind: "github-repo",
          repoFullName: trimmedRepo,
          addedAt,
          ...(syncMode === "import"
            ? {
                sync: {
                  mode: "import" as const,
                  ...(projectV2Number !== undefined ? { projectV2Number } : {}),
                },
              }
            : {}),
        }
      case "workspace-root":
        return { kind: "workspace-root", rootId: selectedRootId, addedAt }
      case "lark-tasklist":
        return {
          kind: "lark-tasklist",
          adapterId: selectedAccountId,
          tasklistGuid: selectedTasklist!.guid,
          name: selectedTasklist!.name,
          addedAt,
        }
      case "lark-bitable": {
        const map: LarkBitableFieldMap = { title: fieldMap.title! }
        for (const name of OPTIONAL_BITABLE_FIELDS) {
          if (fieldMap[name]) map[name] = fieldMap[name]
        }
        const values = Object.fromEntries(
          Object.entries(statusValues).filter(([, value]) => value && value.trim())
        ) as Partial<Record<IssueStatus, string>>
        if (map.status && Object.keys(values).length > 0) map.statusValues = values
        return {
          kind: "lark-bitable",
          adapterId: selectedAccountId,
          appToken: appToken!,
          tableId,
          name: selectedTable!.name,
          fieldMap: map,
          addedAt,
        }
      }
    }
  }

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      const resource = buildResource()
      await addIssueProjectResource(issueProjectId, resource)
      // Adding the first synced resource is what brings the background refresh
      // into existence. Doing it here rather than at boot means a user who
      // binds one sees the board stay fresh without restarting.
      if (isSyncedResource(resource)) await syncGithubIssueSchedule()

      onAdded?.(resource)
      close()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  function setOptionalField(name: OptionalBitableField, value: string) {
    setFieldMap((current) => {
      const next = { ...current }
      if (value === NO_FIELD) delete next[name]
      else next[name] = value
      return next
    })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) onOpenChange(true)
        else close()
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto" data-testid="project-resource-dialog">
        <DialogHeader>
          <DialogTitle>{t("projects.addResource")}</DialogTitle>
          <DialogDescription>{t("projects.addResourceHint")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="resource-kind">{t("projects.resourceKind")}</Label>
            <Select value={kind} onValueChange={(value) => setKind(value as ResourceKind)}>
              <SelectTrigger id="resource-kind" data-testid="resource-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="github-repo">{t("projects.resourceRepo")}</SelectItem>
                <SelectItem value="lark-tasklist">{t("projects.resourceTasklist")}</SelectItem>
                <SelectItem value="lark-bitable">{t("projects.resourceBitable")}</SelectItem>
                <SelectItem value="workspace-root">{t("projects.resourceDirectory")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {kind === "github-repo" ? (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="resource-repo">{t("projects.resourceRepo")}</Label>
                <Input
                  id="resource-repo"
                  value={repo}
                  onChange={(event) => setRepo(event.target.value)}
                  placeholder={t("projects.repoPlaceholder")}
                  className="font-mono"
                  data-testid="resource-repo"
                />
                <p className="text-xs text-muted-foreground" data-testid="resource-repo-hint">
                  {repoInvalid
                    ? t("projects.repoInvalid")
                    : repoTaken
                      ? t("projects.repoTaken")
                      : t("projects.repoHint")}
                </p>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="resource-sync-mode">{t("projects.syncMode")}</Label>
                <Select
                  value={syncMode}
                  onValueChange={(value) => setSyncMode(value as "mirror" | "import")}
                >
                  <SelectTrigger id="resource-sync-mode" data-testid="resource-sync-mode">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="mirror">{t("projects.syncModeMirror")}</SelectItem>
                    <SelectItem value="import">{t("projects.syncModeImportOption")}</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {syncMode === "import"
                    ? t("projects.syncModeImportHint")
                    : t("projects.syncModeMirrorHint")}
                </p>
              </div>
              {syncMode === "import" ? (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="resource-project-v2">{t("projects.projectV2Number")}</Label>
                  <Input
                    id="resource-project-v2"
                    inputMode="numeric"
                    value={projectV2}
                    onChange={(event) => setProjectV2(event.target.value)}
                    placeholder="12"
                    className="w-32"
                    data-testid="resource-project-v2"
                  />
                  <p className="text-xs text-muted-foreground">
                    {projectV2Invalid
                      ? t("projects.projectV2Invalid")
                      : t("projects.projectV2Hint")}
                  </p>
                </div>
              ) : null}
            </>
          ) : null}

          {needsLark ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="resource-lark-account">{t("projects.larkAccount")}</Label>
              {accounts.length === 0 ? (
                <p
                  className="text-xs text-muted-foreground"
                  data-testid="resource-no-lark-accounts"
                >
                  {t("projects.noLarkAccounts")}
                </p>
              ) : (
                <Select value={selectedAccountId} onValueChange={setAccountId}>
                  <SelectTrigger id="resource-lark-account" data-testid="resource-lark-account">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {accounts.map((account) => (
                      <SelectItem key={account.id} value={account.id}>
                        {account.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <p className="text-xs text-muted-foreground">{t("projects.larkScopesHint")}</p>
            </div>
          ) : null}

          {kind === "lark-tasklist" ? (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <Label htmlFor="resource-tasklist">{t("projects.tasklist")}</Label>
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-auto h-7 text-xs"
                  disabled={!selectedAccountId || loading}
                  onClick={loadTasklists}
                  data-testid="resource-load-tasklists"
                >
                  {loading ? t("projects.loading") : t("projects.loadTasklists")}
                </Button>
              </div>
              {tasklists === null ? null : tasklists.length === 0 ? (
                <p className="text-xs text-muted-foreground" data-testid="resource-no-tasklists">
                  {t("projects.noTasklists")}
                </p>
              ) : (
                <Select value={tasklistGuid} onValueChange={setTasklistGuid}>
                  <SelectTrigger id="resource-tasklist" data-testid="resource-tasklist">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {tasklists.map((row) => (
                      <SelectItem key={row.guid} value={row.guid}>
                        {row.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          ) : null}

          {kind === "lark-bitable" ? (
            <>
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <Label htmlFor="resource-bitable">{t("projects.bitableApp")}</Label>
                  <Button
                    size="sm"
                    variant="outline"
                    className="ml-auto h-7 text-xs"
                    disabled={!selectedAccountId || !appToken || loading}
                    onClick={loadTables}
                    data-testid="resource-load-tables"
                  >
                    {loading ? t("projects.loading") : t("projects.loadTables")}
                  </Button>
                </div>
                <Input
                  id="resource-bitable"
                  value={bitableInput}
                  onChange={(event) => setBitableInput(event.target.value)}
                  placeholder="https://xxx.feishu.cn/base/bascn…"
                  className="font-mono"
                  data-testid="resource-bitable"
                />
                <p className="text-xs text-muted-foreground">
                  {bitableInvalid ? t("projects.bitableInvalid") : t("projects.bitableHint")}
                </p>
              </div>
              {tables !== null ? (
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-2">
                    <Label htmlFor="resource-table">{t("projects.table")}</Label>
                    <Button
                      size="sm"
                      variant="outline"
                      className="ml-auto h-7 text-xs"
                      disabled={!tableId || loading}
                      onClick={loadFields}
                      data-testid="resource-load-fields"
                    >
                      {loading ? t("projects.loading") : t("projects.loadFields")}
                    </Button>
                  </div>
                  {tables.length === 0 ? (
                    <p className="text-xs text-muted-foreground">{t("projects.noTables")}</p>
                  ) : (
                    <Select
                      value={tableId}
                      onValueChange={(value) => {
                        setTableId(value)
                        setFields(null)
                        setFieldMap({})
                      }}
                    >
                      <SelectTrigger id="resource-table" data-testid="resource-table">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {tables.map((row) => (
                          <SelectItem key={row.tableId} value={row.tableId}>
                            {row.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
              ) : null}
              {fields !== null ? (
                <div className="flex flex-col gap-2" data-testid="resource-field-map">
                  <p className="text-xs font-medium">{t("projects.fieldMap")}</p>
                  <FieldPick
                    id="title"
                    label={t("projects.field.title")}
                    value={fieldMap.title ?? ""}
                    fields={fields}
                    required
                    onChange={(value) => setFieldMap((current) => ({ ...current, title: value }))}
                    noneLabel={t("projects.fieldNone")}
                  />
                  {OPTIONAL_BITABLE_FIELDS.map((name) => (
                    <FieldPick
                      key={name}
                      id={name}
                      label={t(`projects.field.${name}`)}
                      value={fieldMap[name] ?? NO_FIELD}
                      fields={fields}
                      onChange={(value) => setOptionalField(name, value)}
                      noneLabel={t("projects.fieldNone")}
                    />
                  ))}
                  {fieldMap.status ? (
                    <div className="flex flex-col gap-1.5">
                      <p className="text-xs text-muted-foreground">
                        {t("projects.statusValuesHint")}
                      </p>
                      <div className="grid grid-cols-2 gap-1.5">
                        {ISSUE_STATUSES.map((status) => (
                          <Input
                            key={status}
                            value={statusValues[status] ?? ""}
                            placeholder={t(`status.${status}`)}
                            aria-label={t("projects.statusValueFor", {
                              status: t(`status.${status}`),
                            })}
                            className="h-7 text-xs"
                            onChange={(event) =>
                              setStatusValues((current) => ({
                                ...current,
                                [status]: event.target.value,
                              }))
                            }
                            data-testid={`resource-status-value-${status}`}
                          />
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : null}

          {kind === "workspace-root" ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="resource-root">{t("projects.resourceDirectory")}</Label>
              {availableRoots.length === 0 ? (
                <p className="text-xs text-muted-foreground" data-testid="resource-no-roots">
                  {t("projects.noRootsAvailable")}
                </p>
              ) : (
                <Select value={selectedRootId} onValueChange={setRootId}>
                  <SelectTrigger id="resource-root" data-testid="resource-root">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {availableRoots.map((root) => (
                      <SelectItem key={root.id} value={root.id}>
                        {root.label ?? root.path}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <p className="text-xs text-muted-foreground">{t("projects.directoryHint")}</p>
            </div>
          ) : null}

          {error ? (
            <p className="text-sm text-destructive" data-testid="resource-error">
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={close} disabled={busy}>
            {t("create.cancel")}
          </Button>
          <Button onClick={submit} disabled={!canSubmit} data-testid="resource-submit">
            {t("projects.addResource")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function FieldPick({
  id,
  label,
  value,
  fields,
  required,
  onChange,
  noneLabel,
}: {
  id: string
  label: string
  value: string
  fields: readonly BitableFieldSummary[]
  required?: boolean
  onChange: (value: string) => void
  noneLabel: string
}) {
  return (
    <div className="flex items-center gap-2">
      <Label htmlFor={`resource-field-${id}`} className="w-24 shrink-0 text-xs">
        {label}
      </Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger
          id={`resource-field-${id}`}
          className="h-8 flex-1"
          data-testid={`resource-field-${id}`}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {required ? null : <SelectItem value={NO_FIELD}>{noneLabel}</SelectItem>}
          {fields.map((field) => (
            <SelectItem key={field.fieldId} value={field.name}>
              {field.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

/**
 * A Lark failure, as the dialog should say it. Access errors name the
 * account and the fix (connect, or reconnect with more scopes). Anything
 * else is passed through.
 */
function describeLarkError(cause: unknown, t: ReturnType<typeof useTranslations>): string {
  if (cause && typeof cause === "object" && "code" in cause) {
    const code = (cause as { code: string; account?: string }).code
    if (code === "browserUnsupported") return t("projects.larkDesktopOnly")
    if (code === "noAccount" || code === "notAuthorized") {
      return t("projects.larkNotAuthorized", {
        account: (cause as { account?: string }).account ?? "",
      })
    }
  }
  return cause instanceof Error ? cause.message : String(cause)
}
