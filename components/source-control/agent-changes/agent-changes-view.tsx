"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { BotIcon, RefreshCwIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { useAgentChangesets } from "@/hooks/scm/use-agent-changesets"
import type { ScmHost } from "@/lib/scm/host"
import { TERMINAL_CHANGESET_STATES, type AgentChangeset } from "@/lib/scm/types"
import { ChangesetRow } from "./changeset-row"
import { ChangesetDetail } from "./changeset-detail"
import { IntegrateDialog } from "./integrate-dialog"
import { IntegrationRunList } from "./integration-run-list"
import { changesetActions, integrationReasonKey } from "./presentation"

interface Props {
  rootDir: string
  projectId: string | null
  host?: ScmHost
}

/** The key also clears selection, dialogs and in-flight work on a repository switch. */
export function AgentChangesView(props: Props) {
  return <AgentChangesRepository key={`${props.rootDir}:${props.projectId ?? ""}`} {...props} />
}

function AgentChangesRepository({ rootDir, projectId, host }: Props) {
  const t = useTranslations("agentChanges")
  const appSettings = useSettingsStore((state) => state.settings)
  const data = useAgentChangesets({ rootDir, projectId, appSettings, host })
  const [selected, setSelected] = useState<string[]>([])
  const [detailId, setDetailId] = useState<string | null>(null)
  const [integrationSelection, setIntegrationSelection] = useState<AgentChangeset[] | null>(null)
  const [doneOpen, setDoneOpen] = useState(false)
  const open = data.changesets.filter((item) => !TERMINAL_CHANGESET_STATES.has(item.state))
  const done = data.changesets.filter((item) => TERMINAL_CHANGESET_STATES.has(item.state))
  const selection = data.changesets.filter(
    (item) => selected.includes(item.changesetId) && changesetActions(item.state).select
  )
  const detail = data.changesets.find((item) => item.changesetId === detailId)
  const row = (item: AgentChangeset) => (
    <ChangesetRow
      key={item.changesetId}
      changeset={item}
      selected={selection.some((selectedItem) => selectedItem.changesetId === item.changesetId)}
      disabled={data.busy}
      onOpen={() => setDetailId(item.changesetId)}
      onSelect={(checked) =>
        setSelected((previous) =>
          checked
            ? [...new Set([...previous, item.changesetId])]
            : previous.filter((id) => id !== item.changesetId)
        )
      }
    />
  )
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="agent-changes-view">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b p-3">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <BotIcon className="size-4" aria-hidden />
          {t("title")}
        </h2>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={data.loading || data.busy}
            onClick={() => void data.refresh()}
            aria-label={t("refresh")}
            data-testid="agent-changes-refresh"
          >
            <RefreshCwIcon className="size-3.5" aria-hidden />
          </Button>
          <Button
            size="sm"
            disabled={data.busy || selection.length === 0}
            onClick={() => setIntegrationSelection(selection)}
            data-testid="agent-changes-integrate"
          >
            {t("integrateSelected", { count: selection.length })}
          </Button>
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 p-3">
          {data.error && (
            <div role="alert" className="space-y-2 rounded border border-destructive p-3 text-sm">
              <p>{t(`errors.${data.error.kind}`)}</p>
              {data.error.code && (
                <p>{t(integrationReasonKey(data.error.code), { code: data.error.code })}</p>
              )}
              <Button
                size="sm"
                variant="outline"
                disabled={data.loading || data.busy}
                onClick={() => void data.refresh()}
              >
                {t("retry")}
              </Button>
            </div>
          )}
          {data.loading && (
            <p role="status" className="text-sm text-muted-foreground">
              {t("loading")}
            </p>
          )}
          {!data.loading && !data.error && data.changesets.length === 0 && (
            <p
              data-testid="agent-changes-empty"
              className="py-8 text-center text-sm text-muted-foreground"
            >
              {t("empty")}
            </p>
          )}
          <section aria-label={t("groups.open")} data-testid="agent-changes-open">
            <h3 className="mb-2 text-sm font-medium">{t("groups.open")}</h3>
            <ul className="space-y-2">{open.map(row)}</ul>
          </section>
          <Collapsible open={doneOpen} onOpenChange={setDoneOpen}>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm" data-testid="agent-changes-done-toggle">
                {t("groups.done", { count: done.length })}
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <ul className="space-y-2 pt-2" data-testid="agent-changes-done">
                {done.map(row)}
              </ul>
            </CollapsibleContent>
          </Collapsible>
          {detail && (
            <ChangesetDetail
              key={`${detail.changesetId}:${detail.headSha}`}
              changeset={detail}
              projectId={projectId}
              host={data.host}
              actions={data}
            />
          )}
          <IntegrationRunList integrations={data.integrations} actions={data} />
        </div>
      </ScrollArea>
      {integrationSelection && (
        <IntegrateDialog
          rootDir={rootDir}
          projectId={projectId}
          changesets={integrationSelection}
          host={data.host}
          actions={data}
          onClose={() => setIntegrationSelection(null)}
        />
      )}
    </div>
  )
}
