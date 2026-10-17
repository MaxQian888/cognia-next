"use client"

import { useId, useState } from "react"
import { useFormatter, useNow, useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Textarea } from "@/components/ui/textarea"
import { Progress } from "@/components/ui/progress"
import { useSandboxSnapshots } from "@/hooks/sandbox/use-sandbox-snapshots"
import { formatBytesCompact } from "@/lib/observability/format-utils"
import type { SandboxPreviewContext } from "@/lib/sandbox/previews"
import type { WorkspaceEnvironmentSummary } from "@/lib/task-workspace/types"

export function SandboxSnapshotsPanel({
  projectId,
  context,
  workspaces,
  onChanged,
}: {
  projectId: string
  context: SandboxPreviewContext
  workspaces: WorkspaceEnvironmentSummary[]
  onChanged(): Promise<void>
}) {
  const t = useTranslations("sandboxManagement")
  const format = useFormatter()
  const now = useNow({ updateInterval: 60_000 })
  const id = useId()
  const state = useSandboxSnapshots(projectId)
  const [targetId, setTargetId] = useState("")
  const [restoreId, setRestoreId] = useState("")
  const [exclusions, setExclusions] = useState("")
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const targets = context.targets.filter((target) => target.workspaceState === "active")
  const target =
    targets.find((row) => `${row.workspaceId}:${row.containerId}` === targetId) ?? targets[0]
  const restorable = workspaces.filter(
    (row) =>
      row.workspaceId &&
      (row.state === "archived" || row.state === "restorable") &&
      row.allowedActions.includes("restore")
  )
  const restore = restorable.find((row) => row.workspaceId === restoreId)
  const overBudget = context.snapshotUsageBytes >= context.sandboxSnapshotBudgetBytes
  const visibleSnapshots = state.snapshots.filter((row) => row.phase !== "tombstoned")
  const mutate = async (action: () => Promise<void>) => {
    await action()
    await onChanged()
  }

  return (
    <section aria-labelledby={`${id}-title`} className="space-y-3 border-t pt-3">
      <h4 id={`${id}-title`} className="text-sm font-medium">
        {t("snapshots.title")}
      </h4>
      <p className="text-xs text-muted-foreground">{t("snapshots.description")}</p>
      <p className="text-xs">
        {t("snapshots.budget", {
          used: formatBytesCompact(context.snapshotUsageBytes),
          budget: formatBytesCompact(context.sandboxSnapshotBudgetBytes),
        })}
      </p>
      <Progress
        value={
          context.sandboxSnapshotBudgetBytes > 0
            ? Math.min(100, (context.snapshotUsageBytes / context.sandboxSnapshotBudgetBytes) * 100)
            : 100
        }
        aria-label={t("snapshots.budgetLabel")}
      />
      {overBudget ? (
        <p role="alert" className="text-xs text-destructive">
          {t("snapshots.errors.budget")}
        </p>
      ) : null}
      <div className="space-y-1">
        <Label htmlFor={`${id}-target`}>{t("snapshots.target")}</Label>
        <NativeSelect
          id={`${id}-target`}
          value={target ? `${target.workspaceId}:${target.containerId}` : ""}
          onChange={(event) => setTargetId(event.target.value)}
          disabled={state.busy || !targets.length}
        >
          {!targets.length ? (
            <NativeSelectOption value="">{t("snapshots.noTargets")}</NativeSelectOption>
          ) : null}
          {targets.map((row) => (
            <NativeSelectOption
              key={`${row.workspaceId}:${row.containerId}`}
              value={`${row.workspaceId}:${row.containerId}`}
            >
              {row.executionRoot}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <Label htmlFor={`${id}-exclusions`}>{t("snapshots.exclusions")}</Label>
        <Textarea
          id={`${id}-exclusions`}
          value={exclusions}
          onChange={(event) => setExclusions(event.target.value)}
          disabled={state.busy}
          placeholder={t("snapshots.exclusionsPlaceholder")}
        />
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={state.busy || state.loading || !target || overBudget}
          onClick={() => {
            if (target)
              void mutate(() =>
                state.create({
                  workspaceId: target.workspaceId,
                  provider: target.provider,
                  containerId: target.containerId,
                  exclusions: exclusions
                    .split(/\r?\n/)
                    .map((value) => value.trim())
                    .filter(Boolean),
                })
              )
          }}
        >
          {t("snapshots.create")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={state.busy || state.loading}
          onClick={() => void mutate(state.refresh)}
        >
          {t("refresh")}
        </Button>
      </div>
      {state.busy ? (
        <p role="status" className="text-xs">
          {t("snapshots.busy")}
        </p>
      ) : null}
      {state.error ? (
        <p role="alert" className="text-xs text-destructive">
          {t(`snapshots.errors.${state.error}`)}
        </p>
      ) : null}
      {state.forked ? (
        <p role="status" className="break-all text-xs">
          {t(state.forked.restoredInPlace ? "snapshots.restored" : "snapshots.forked", {
            root: state.forked.workspace.executionRoot,
          })}
        </p>
      ) : null}
      {restorable.length ? (
        <div className="space-y-1">
          <Label htmlFor={`${id}-restore`}>{t("snapshots.restoreTarget")}</Label>
          <NativeSelect
            id={`${id}-restore`}
            value={restoreId}
            onChange={(event) => setRestoreId(event.target.value)}
            disabled={state.busy}
          >
            <NativeSelectOption value="">{t("snapshots.chooseRestore")}</NativeSelectOption>
            {restorable.map((row) => (
              <NativeSelectOption key={row.workspaceId} value={row.workspaceId!}>
                {row.path}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <p className="text-xs text-muted-foreground">{t("snapshots.restoreWarning")}</p>
        </div>
      ) : null}
      {state.loading ? (
        <p role="status" className="text-xs">
          {t("loading")}
        </p>
      ) : !visibleSnapshots.length ? (
        <p className="text-xs text-muted-foreground">{t("snapshots.empty")}</p>
      ) : null}
      <ul className="space-y-2">
        {visibleSnapshots.map((snapshot) => (
          <li key={snapshot.snapshotId} className="space-y-2 rounded-md border p-3">
            <p className="break-all text-xs">{snapshot.workspaceRoot}</p>
            <p className="text-xs text-muted-foreground">
              {t("snapshots.details", {
                size: formatBytesCompact(snapshot.imageBytes),
                age: format.relativeTime(new Date(snapshot.createdAt), now),
              })}
            </p>
            <p className="text-xs">
              {t(`snapshots.phases.${snapshot.phase}`)}
              {snapshot.pinned ? ` · ${t("snapshots.pinned")}` : ""}
            </p>
            {snapshot.exclusions.length ? (
              <p className="break-all text-xs">
                {t("snapshots.recordedExclusions", { paths: snapshot.exclusions.join(", ") })}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={state.busy || state.loading || snapshot.phase !== "ready"}
                onClick={() => void mutate(() => state.pin(snapshot.snapshotId, !snapshot.pinned))}
              >
                {t(snapshot.pinned ? "snapshots.unpin" : "snapshots.pin")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={state.busy || state.loading || snapshot.phase !== "ready"}
                onClick={() => void mutate(() => state.fork(snapshot.snapshotId))}
              >
                {t("snapshots.fork")}
              </Button>
              {restore ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={state.busy || state.loading || snapshot.phase !== "ready"}
                  onClick={() =>
                    void mutate(() => state.restore(snapshot.snapshotId, restore.workspaceId!))
                  }
                >
                  {t("snapshots.restore")}
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="ghost"
                disabled={state.busy || state.loading}
                onClick={() => setDeleteId(snapshot.snapshotId)}
              >
                {t("snapshots.delete")}
              </Button>
            </div>
            {deleteId === snapshot.snapshotId ? (
              <div role="group" aria-label={t("snapshots.deleteConfirm")} className="space-y-2">
                <p className="text-xs">{t("snapshots.deleteConfirm")}</p>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={state.busy}
                  onClick={() => {
                    setDeleteId(null)
                    void mutate(() => state.remove(snapshot.snapshotId))
                  }}
                >
                  {t("snapshots.confirmDelete")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setDeleteId(null)}>
                  {t("cancel")}
                </Button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  )
}
