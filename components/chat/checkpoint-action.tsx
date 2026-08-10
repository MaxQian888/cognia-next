"use client"

import { useSyncExternalStore, useState } from "react"
import { useTranslations } from "next-intl"

import { Checkpoint, CheckpointIcon, CheckpointTrigger } from "@/components/ai-elements/checkpoint"
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
  isAgentExecutionFlagEnabled,
  subscribeToAgentExecutionFlags,
} from "@/lib/ai/agent/execution/feature-flags"
import type { RewindFilesResult } from "@/lib/claude/ipc"
import { Badge } from "@/components/ui/badge"

interface CheckpointActionProps {
  checkpointId: string
  enabled: boolean
  rewindFiles: (checkpointId: string, dryRun: boolean) => Promise<RewindFilesResult>
}

export function CheckpointAction({ checkpointId, enabled, rewindFiles }: CheckpointActionProps) {
  const t = useTranslations("chat.checkpoint")
  const checkpointCapability = useSyncExternalStore(
    subscribeToAgentExecutionFlags,
    () =>
      isAgentExecutionFlagEnabled("claudeSdkParityV1") &&
      isAgentExecutionFlagEnabled("claudeSdkCheckpoint"),
    () => false
  )
  const [preview, setPreview] = useState<RewindFilesResult | null>(null)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!enabled || !checkpointCapability || !checkpointId) return null

  const prepare = async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await rewindFiles(checkpointId, true)
      setPreview(result)
      setOpen(true)
    } catch {
      setError(t("previewFailed"))
      setOpen(true)
    } finally {
      setLoading(false)
    }
  }

  const confirm = async () => {
    setLoading(true)
    setError(null)
    try {
      await rewindFiles(checkpointId, false)
      setOpen(false)
    } catch {
      setError(t("restoreFailed"))
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <Checkpoint className="[&_[data-slot=separator-root]]:hidden">
        <CheckpointTrigger
          aria-label={t("action")}
          disabled={loading}
          onClick={() => void prepare()}
          size="icon-sm"
          tooltip={t("action")}
        >
          <CheckpointIcon className="size-3.5" />
        </CheckpointTrigger>
      </Checkpoint>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("title")}</AlertDialogTitle>
            <AlertDialogDescription>{t("description")}</AlertDialogDescription>
          </AlertDialogHeader>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : preview ? (
            <div className="max-h-56 space-y-3 overflow-auto rounded-md bg-muted p-3 text-xs">
              <Badge variant="outline">{t(`status.${preview.status}`)}</Badge>
              {preview.reason ? (
                <p>
                  <span className="font-medium">{t("reason")}: </span>
                  {preview.reason}
                </p>
              ) : null}
              <div>
                <p className="font-medium">{t("affectedFiles")}</p>
                {preview.paths.length > 0 ? (
                  <ul className="mt-1 space-y-1 font-mono">
                    {preview.paths.map((path) => (
                      <li key={path}>{path}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1 text-muted-foreground">{t("noAffectedFiles")}</p>
                )}
              </div>
            </div>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction disabled={loading || !!error} onClick={() => void confirm()}>
              {t("confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
