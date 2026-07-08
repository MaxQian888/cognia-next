"use client"

/**
 * Mobile Agent-Team task board (team-board CQRS, ADR-0027 companion).
 *
 * READ side: renders the Dexie `agentTeamBoard` mirror (v104) via liveQuery —
 * the phone shows whatever last synced, desktop reachable or not. WRITE side:
 * every control round-trips a live Companion RPC (`team_task_move` /
 * `team_task_create`-less here / `team_task_comment` / `team_run_*`) —
 * deliberately NOT the offline outbound queue, because a move must validate
 * against the desktop's LIVE run state (the desktop re-runs `canMoveTask`).
 * No touch drag: moves go through an explicit action sheet whose targets come
 * from the same `allowedMoveTargets` guard as the desktop kanban.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import {
  BotIcon,
  LockIcon,
  MessageSquareIcon,
  PauseIcon,
  PlayIcon,
  SendIcon,
  SquareIcon,
} from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { StatusBadge } from "@/components/status-badge"
import { cn } from "@/lib/utils"
import { getDb } from "@/lib/db/schema"
import { transport } from "@/lib/tauri/transport-instance"
import { BOARD_COLUMN_ORDER } from "@/lib/ai/agent/team/board-model"
import { allowedMoveTargets } from "@/lib/ai/agent/team/task-move-guard"
import { TASK_STATUS_CONFIG } from "@/types/agent/agent-team"
import type { TeamStatus, TeamTaskStatus } from "@/types/agent/agent-team"
import type { AgentTeamBoardTaskRow, AgentTeamBoardTeamRow } from "@/lib/db/agent-team-board"

export interface TeamBoardMobileProps {
  teamId: string
}

function sortRows(rows: AgentTeamBoardTaskRow[]): AgentTeamBoardTaskRow[] {
  return [...rows].sort(
    (a, b) => a.order - b.order || a.createdAt - b.createdAt || a.id.localeCompare(b.id)
  )
}

export function TeamBoardMobile({ teamId }: TeamBoardMobileProps) {
  const t = useTranslations("mobile.agentTeams.board")
  const [busy, setBusy] = useState(false)
  const [detailTaskId, setDetailTaskId] = useState<string | null>(null)
  const [comment, setComment] = useState("")

  const rows = useLiveQuery(
    () => getDb().agentTeamBoard.where("teamId").equals(teamId).toArray(),
    [teamId]
  )

  const meta = useMemo(
    () => rows?.find((r): r is AgentTeamBoardTeamRow => r.kind === "team"),
    [rows]
  )
  const tasks = useMemo(
    () => (rows ?? []).filter((r): r is AgentTeamBoardTaskRow => r.kind === "task"),
    [rows]
  )
  const columns = useMemo(
    () =>
      BOARD_COLUMN_ORDER.map((status) => ({
        status,
        tasks: sortRows(tasks.filter((task) => task.status === status)),
      })),
    [tasks]
  )
  const teamStatus: TeamStatus = meta?.status ?? "idle"
  const detailTask = detailTaskId ? (tasks.find((task) => task.id === detailTaskId) ?? null) : null

  const nameOf = (id: string | undefined) =>
    id ? (meta?.teammates.find((m) => m.id === id)?.name ?? id) : undefined
  const twinBound = (id: string | undefined) =>
    id ? Boolean(meta?.teammates.find((m) => m.id === id)?.twinId) : false

  const call = async (command: string, payload: Record<string, unknown>): Promise<boolean> => {
    setBusy(true)
    try {
      const result = (await transport.call(command, payload)) as {
        ok?: boolean
        reason?: string
      } | null
      if (result?.ok) {
        toast.success(t("applied"))
        return true
      }
      toast.error(t("commandFailed", { reason: result?.reason ?? "unknown" }))
      return false
    } catch {
      // Desktop unreachable — the board keeps rendering the last-synced
      // snapshot; controls just report the failed round-trip.
      toast.error(t("offline"))
      return false
    } finally {
      setBusy(false)
    }
  }

  const moveTargets = detailTask
    ? allowedMoveTargets(
        { id: detailTask.id, dependencies: detailTask.dependencies, status: detailTask.status },
        teamStatus
      )
    : []

  if (!rows || rows.length === 0) {
    return (
      <p className="px-1 text-xs text-muted-foreground" data-testid="mobile-board-empty">
        {t("empty")}
      </p>
    )
  }

  return (
    <div className="space-y-3" data-testid="mobile-team-board">
      {/* Run controls driven by the synced team status. */}
      <div className="flex items-center gap-2">
        {meta && <StatusBadge value={meta.status} labelNamespace="agentTeam.status" />}
        <div className="ml-auto flex gap-1.5">
          {teamStatus === "executing" || teamStatus === "planning" ? (
            <Button
              size="sm"
              variant="outline"
              className="min-h-11"
              disabled={busy}
              onClick={() => void call("team_run_pause", { teamId })}
              data-testid="mobile-board-pause"
            >
              <PauseIcon className="mr-1 size-3.5" />
              {t("run.pause")}
            </Button>
          ) : teamStatus === "paused" ? (
            <Button
              size="sm"
              className="min-h-11"
              disabled={busy}
              onClick={() => void call("team_run_resume", { teamId })}
              data-testid="mobile-board-resume"
            >
              <PlayIcon className="mr-1 size-3.5" />
              {t("run.resume")}
            </Button>
          ) : null}
          {(teamStatus === "executing" || teamStatus === "planning" || teamStatus === "paused") && (
            <Button
              size="sm"
              variant="outline"
              className="min-h-11"
              disabled={busy}
              onClick={() => void call("team_run_stop", { teamId })}
              data-testid="mobile-board-stop"
            >
              <SquareIcon className="mr-1 size-3.5" />
              {t("run.stop")}
            </Button>
          )}
        </div>
      </div>

      {/* Columns — horizontal scroll, tap a card for detail + actions. */}
      <div className="flex gap-2 overflow-x-auto pb-2" data-testid="mobile-board-columns">
        {columns.map((column) => (
          <div
            key={column.status}
            className="w-56 shrink-0 space-y-1.5 rounded-lg bg-muted/40 p-2"
            data-testid={`mobile-board-column-${column.status}`}
          >
            <div className="flex items-center justify-between px-1">
              <StatusBadge
                value={TASK_STATUS_CONFIG[column.status].labelKey}
                labelNamespace="agentTeam.taskStatus"
                className="text-[10px]"
              />
              <span className="text-[10px] text-muted-foreground">{column.tasks.length}</span>
            </div>
            {column.tasks.map((task) => (
              <Card
                key={task.id}
                className="cursor-pointer space-y-1 p-2.5"
                onClick={() => setDetailTaskId(task.id)}
                data-testid={`mobile-board-card-${task.id}`}
              >
                <p className="truncate text-xs font-medium">{task.title}</p>
                <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                  <Badge variant="secondary" className="px-1 py-0 text-[10px]">
                    {task.priority}
                  </Badge>
                  {nameOf(task.claimedBy ?? task.assignedTo) && (
                    <span className="truncate">{nameOf(task.claimedBy ?? task.assignedTo)}</span>
                  )}
                  {twinBound(task.claimedBy ?? task.assignedTo) && (
                    <BotIcon
                      className="size-3"
                      aria-label={t("twinBound")}
                      data-testid={`mobile-board-card-${task.id}-twin`}
                    />
                  )}
                  {task.dependencies.length > 0 && <LockIcon className="size-3 text-red-400" />}
                  {task.commentCount > 0 && (
                    <span className="inline-flex items-center gap-0.5">
                      <MessageSquareIcon className="size-3" />
                      {task.commentCount}
                    </span>
                  )}
                </div>
              </Card>
            ))}
          </div>
        ))}
      </div>

      {/* Detail sheet: full text, thread, action-sheet moves, comment composer. */}
      <Sheet open={detailTask !== null} onOpenChange={(open) => !open && setDetailTaskId(null)}>
        <SheetContent side="bottom" className="max-h-[85dvh] overflow-y-auto">
          {detailTask && (
            <>
              <SheetHeader className="text-left">
                <SheetTitle>{detailTask.title}</SheetTitle>
                {detailTask.description && (
                  <SheetDescription>{detailTask.description}</SheetDescription>
                )}
              </SheetHeader>
              <div className="space-y-3 px-4 pb-6">
                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                  <StatusBadge
                    value={TASK_STATUS_CONFIG[detailTask.status].labelKey}
                    labelNamespace="agentTeam.taskStatus"
                  />
                  <Badge variant="secondary">{detailTask.priority}</Badge>
                  {nameOf(detailTask.claimedBy ?? detailTask.assignedTo) && (
                    <span className="text-muted-foreground">
                      {nameOf(detailTask.claimedBy ?? detailTask.assignedTo)}
                    </span>
                  )}
                  {detailTask.tags.map((tag) => (
                    <span key={tag} className="rounded bg-muted px-1 py-0.5 text-[10px]">
                      {tag}
                    </span>
                  ))}
                </div>

                {detailTask.errorPreview && (
                  <p className="text-xs text-destructive">{detailTask.errorPreview}</p>
                )}
                {detailTask.resultPreview && (
                  <p className="text-xs italic text-muted-foreground">
                    {detailTask.resultPreview}
                  </p>
                )}

                {/* Action-sheet moves — same guard as the desktop drag. */}
                {moveTargets.length > 0 && (
                  <div className="space-y-1.5">
                    <p className="text-xs font-medium">{t("moveTo")}</p>
                    <div className="flex flex-wrap gap-1.5">
                      {moveTargets.map((to: TeamTaskStatus) => (
                        <Button
                          key={to}
                          size="sm"
                          variant="outline"
                          className="min-h-11"
                          disabled={busy}
                          onClick={() =>
                            void call("team_task_move", {
                              teamId,
                              taskId: detailTask.id,
                              to,
                            }).then((ok) => {
                              if (ok) setDetailTaskId(null)
                            })
                          }
                          data-testid={`mobile-board-move-${to}`}
                        >
                          <StatusBadge
                            value={TASK_STATUS_CONFIG[to].labelKey}
                            labelNamespace="agentTeam.taskStatus"
                            className="text-[10px]"
                          />
                        </Button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Synced (capped) comment thread + live composer. */}
                <div className="space-y-1.5">
                  <p className="text-xs font-medium">
                    {t("comments", { count: detailTask.commentCount })}
                  </p>
                  {detailTask.comments.map((c) => (
                    <div key={c.id} className="rounded bg-muted/50 p-2 text-xs">
                      <p className="font-medium">{c.authorName}</p>
                      <p className="whitespace-pre-wrap text-muted-foreground">{c.text}</p>
                    </div>
                  ))}
                  <div className="flex gap-1.5">
                    <Input
                      value={comment}
                      onChange={(e) => setComment(e.target.value)}
                      placeholder={t("commentPlaceholder")}
                      className={cn("h-11 text-sm")}
                      data-testid="mobile-board-comment-input"
                    />
                    <Button
                      size="sm"
                      className="min-h-11"
                      disabled={busy || comment.trim().length === 0}
                      onClick={() =>
                        void call("team_task_comment", {
                          teamId,
                          taskId: detailTask.id,
                          text: comment.trim(),
                        }).then((ok) => {
                          if (ok) setComment("")
                        })
                      }
                      data-testid="mobile-board-comment-send"
                    >
                      <SendIcon className="size-3.5" />
                    </Button>
                  </div>
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  )
}
