"use client"

/**
 * Environment variables and secret references for the selected Site.
 *
 * The previous panel offered two always-empty textareas and no view of what was
 * stored — and `saveEnvironment` replaces the whole variable set, so pressing
 * save without retyping silently wiped every variable. Here the saved revision
 * is rendered as data first, the editor is opt-in and pre-filled, and the diff
 * against the current revision is shown before the write.
 *
 * Secret *values* are never rendered: they live in the host keyring, and the
 * revision only records a credential id and a revision marker.
 */
import { useMemo, useState } from "react"
import { useTranslations, useFormatter, useNow } from "next-intl"
import { KeyRoundIcon, PencilIcon, VariableIcon } from "lucide-react"

import { KvEditor } from "@/components/settings/mcp/kv-editor"
import {
  kvRowsToObject,
  objectToKvRows,
  type KvRow,
} from "@/components/settings/mcp/mcp-server-utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Separator } from "@/components/ui/separator"
import {
  environmentDiffIsEmpty,
  environmentRevisionDiff,
  latestEnvironmentRevision,
  sortEnvironmentRevisions,
} from "@/lib/sites/console-model"
import { cn } from "@/lib/utils"
import type { SiteGate } from "@/hooks/sites/use-site-action-gate"
import type { SiteEnvironmentRevisionRow } from "@/types/sites"

export interface SiteEnvironmentTabProps {
  environments: readonly SiteEnvironmentRevisionRow[]
  gate: SiteGate
  busy: boolean
  onSave: (input: { variables: Record<string, string>; secrets: Record<string, string> }) => void
}

export function SiteEnvironmentTab({ environments, gate, busy, onSave }: SiteEnvironmentTabProps) {
  const t = useTranslations("sites")
  const format = useFormatter()
  const now = useNow()

  const current = latestEnvironmentRevision(environments)
  const history = useMemo(() => sortEnvironmentRevisions(environments), [environments])

  const [editing, setEditing] = useState(false)
  const [variableRows, setVariableRows] = useState<KvRow[]>([])
  const [secretRows, setSecretRows] = useState<KvRow[]>([])

  const beginEdit = (revision: SiteEnvironmentRevisionRow | undefined) => {
    // Seed from the revision so an untouched save is a no-op instead of a wipe.
    setVariableRows(objectToKvRows(revision?.variables ?? {}))
    setSecretRows([])
    setEditing(true)
  }

  const draftVariables = kvRowsToObject(variableRows)
  const diff = environmentRevisionDiff(current, draftVariables)
  const unchanged = environmentDiffIsEmpty(diff) && secretRows.length === 0

  if (!current && !editing) {
    return (
      <Empty role="status" className="gap-3 px-4 py-12" data-testid="site-environment-empty">
        <EmptyHeader>
          <EmptyMedia variant="icon" className="bg-primary/10 text-primary">
            <VariableIcon aria-hidden />
          </EmptyMedia>
          <EmptyTitle className="text-sm">{t("environment.title")}</EmptyTitle>
          <EmptyDescription className="max-w-[22rem] text-xs">
            {t("environment.noRevision")}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button
            type="button"
            size="sm"
            disabled={busy || !gate.allowed}
            title={gate.title}
            onClick={() => beginEdit(undefined)}
            data-testid="site-environment-edit"
          >
            <PencilIcon aria-hidden className="size-4" />
            {t("environment.edit")}
          </Button>
        </EmptyContent>
      </Empty>
    )
  }

  return (
    <section
      className="grid gap-4 lg:grid-cols-[14rem_minmax(0,1fr)]"
      data-testid="site-environment-tab"
    >
      <aside className="space-y-1">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t("environment.history")}
        </h3>
        <ul className="space-y-1">
          {history.map((revision) => (
            <li key={revision.id}>
              <button
                type="button"
                onClick={() => beginEdit(revision)}
                data-testid={`site-environment-revision-${revision.id}`}
                disabled={busy || !gate.allowed}
                title={gate.title}
                className={cn(
                  "w-full rounded-md border px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent/50 disabled:opacity-60 motion-reduce:transition-none",
                  revision.id === current?.id && "border-primary bg-primary/5"
                )}
              >
                <span className="block font-medium">
                  {t("environment.revisionLabel", { sequence: revision.sequence })}
                </span>
                <span className="block text-muted-foreground">
                  {t("environment.savedAt", {
                    when: format.relativeTime(new Date(revision.createdAt), now),
                  })}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <div className="min-w-0 space-y-4">
        {current ? (
          <div className="rounded-xl border">
            <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
              <h3 className="text-sm font-medium">{t("environment.currentRevision")}</h3>
              <Badge variant="outline" className="font-normal tabular-nums">
                {t("environment.revisionLabel", { sequence: current.sequence })}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {t("environment.savedAt", {
                  when: format.relativeTime(new Date(current.createdAt), now),
                })}
              </span>
              {!editing ? (
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  className="ml-auto"
                  disabled={busy || !gate.allowed}
                  title={gate.title}
                  onClick={() => beginEdit(current)}
                  data-testid="site-environment-edit"
                >
                  <PencilIcon aria-hidden className="size-3" />
                  {t("actions.editEnvironment")}
                </Button>
              ) : null}
            </div>

            <div className="space-y-3 p-3">
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t("environment.variables")}
                </h4>
                <dl
                  className="mt-1 divide-y rounded-md border text-xs"
                  data-testid="site-environment-variables"
                >
                  {Object.entries(current.variables).map(([key, value]) => (
                    <div key={key} className="flex gap-3 px-2 py-1.5">
                      <dt className="w-1/3 shrink-0 truncate font-mono font-medium">{key}</dt>
                      <dd className="min-w-0 flex-1 truncate font-mono text-muted-foreground">
                        {value}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>

              <Separator />

              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {t("environment.secretRefs")}
                  </h4>
                  <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                    <KeyRoundIcon aria-hidden className="size-3" />
                    {t("environment.secretValueHidden")}
                  </span>
                </div>
                {current.secretRefs.length === 0 ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t("environment.noSecretRefs")}
                  </p>
                ) : (
                  <ul className="mt-1 divide-y rounded-md border text-xs">
                    {current.secretRefs.map((reference) => (
                      <li key={reference.key} className="flex flex-wrap gap-3 px-2 py-1.5">
                        <span className="w-1/3 shrink-0 truncate font-mono font-medium">
                          {reference.key}
                        </span>
                        <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">
                          {t("environment.credential")}: {reference.credentialId}
                        </span>
                        <span className="shrink-0 font-mono text-muted-foreground">
                          {t("environment.revision")} {reference.revision}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>
        ) : null}

        {editing ? (
          <div className="space-y-3 rounded-xl border p-3" data-testid="site-environment-editor">
            <KvEditor
              label={t("environment.variables")}
              rows={variableRows}
              onChange={setVariableRows}
              keyPlaceholder="API_ORIGIN"
              valuePlaceholder="https://api.example.com"
            />
            <KvEditor
              label={t("environment.secrets")}
              rows={secretRows}
              onChange={setSecretRows}
              keyPlaceholder="API_TOKEN"
              valuePlaceholder="secret-value"
              maskValues
            />

            <p className="text-xs text-warning">{t("environment.overwriteWarning")}</p>

            <div
              className="flex flex-wrap items-center gap-2 text-xs"
              data-testid="site-environment-diff"
            >
              {unchanged ? (
                <span className="text-muted-foreground">{t("environment.diff.none")}</span>
              ) : (
                <>
                  <span className="text-success">
                    {t("environment.diff.added", { count: diff.added.length })}
                  </span>
                  <span className="text-info">
                    {t("environment.diff.changed", { count: diff.changed.length })}
                  </span>
                  <span className="text-destructive">
                    {t("environment.diff.removed", { count: diff.removed.length })}
                  </span>
                </>
              )}
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                disabled={busy || !gate.allowed}
                title={gate.title}
                onClick={() =>
                  onSave({ variables: draftVariables, secrets: kvRowsToObject(secretRows) })
                }
                data-testid="site-environment-save"
              >
                {t("actions.saveEnvironment")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => setEditing(false)}
              >
                {t("actions.cancelEdit")}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  )
}
