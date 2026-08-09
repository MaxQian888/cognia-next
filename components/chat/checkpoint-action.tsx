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
import { sessionControl } from "@/lib/claude/ipc"

interface CheckpointActionProps {
  checkpointId: string
  sessionId: string
  enabled: boolean
}

export function CheckpointAction({ checkpointId, sessionId, enabled }: CheckpointActionProps) {
  const t = useTranslations("chat.checkpoint")
  const checkpointCapability = useSyncExternalStore(
    subscribeToAgentExecutionFlags,
    () =>
      isAgentExecutionFlagEnabled("claudeSdkParityV1") &&
      isAgentExecutionFlagEnabled("claudeSdkCheckpoint"),
    () => false
  )
  const [preview, setPreview] = useState<unknown>(null)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!enabled || !checkpointCapability || !checkpointId) return null

  const prepare = async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await sessionControl(sessionId, "rewindFiles", {
        userMessageId: checkpointId,
        options: { dryRun: true },
      })
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
      await sessionControl(sessionId, "rewindFiles", {
        userMessageId: checkpointId,
        options: { dryRun: false },
      })
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
          ) : (
            <pre className="max-h-56 overflow-auto rounded-md bg-muted p-3 text-xs">
              {JSON.stringify(preview, null, 2)}
            </pre>
          )}
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
