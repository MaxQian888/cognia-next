"use client"

import { useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import { DownloadIcon, Trash2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import {
  getSessionAssetMetadata,
  getSessionAsset,
  deleteSessionAsset,
} from "@/lib/db/session-assets"
import { downloadBlob } from "@/lib/files/download"

/** Shared source controls for documents, images, audio, and grouped video frames. */
export function AttachmentSourceActions({
  sessionId,
  assetId,
}: {
  sessionId: string
  assetId: string
}) {
  const t = useTranslations("chat.filePreview.source")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [missing, setMissing] = useState(false)
  const [removed, setRemoved] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const result = useLiveQuery(async () => {
    try {
      return { asset: await getSessionAssetMetadata(sessionId, assetId), failed: false }
    } catch {
      return { asset: undefined, failed: true }
    }
  }, [sessionId, assetId])
  const asset = removed ? undefined : result?.asset

  async function download() {
    setBusy(true)
    setError(false)
    try {
      const source = await getSessionAsset(sessionId, assetId)
      if (!source) {
        setMissing(true)
        return
      }
      downloadBlob(source.blob, source.filename)
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    setBusy(true)
    setError(false)
    try {
      await deleteSessionAsset(sessionId, assetId)
      setRemoved(true)
      setConfirmOpen(false)
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
      {asset?.sourceAvailable && !missing ? (
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void download()}>
          <DownloadIcon className="size-3" aria-hidden />
          {t("download")}
        </Button>
      ) : result && !result.failed ? (
        <span>{removed ? t("removed") : t("unavailable")}</span>
      ) : null}
      {asset ? (
        <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <AlertDialogTrigger asChild>
            <Button variant="ghost" size="sm" disabled={busy}>
              <Trash2Icon className="size-3" aria-hidden />
              {t("remove")}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("removeTitle")}</AlertDialogTitle>
              <AlertDialogDescription>{t("removeDescription")}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy}>{t("cancel")}</AlertDialogCancel>
              <AlertDialogAction
                disabled={busy}
                onClick={(event) => {
                  event.preventDefault()
                  void remove()
                }}
              >
                {t("confirm")}
              </AlertDialogAction>
            </AlertDialogFooter>
            {error ? <p role="alert">{t("failed")}</p> : null}
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
      {(error && !confirmOpen) || result?.failed ? <span role="alert">{t("failed")}</span> : null}
    </div>
  )
}
