"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { DownloadIcon } from "lucide-react"
import { toast } from "sonner"

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
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { downloadBlob } from "@/lib/files/download"
import { getLocalRuntimeDiagnostics } from "@/lib/native/local-runtime"
import { buildSupportFeedbackDraft } from "@/lib/support-agent/feedback"

export function SupportFeedbackDialog() {
  const t = useTranslations("mobile.me.feedback.support")
  const [summary, setSummary] = useState("")
  const [exporting, setExporting] = useState(false)

  const confirmExport = async () => {
    if (exporting) return
    setExporting(true)
    try {
      const diagnostics = await getLocalRuntimeDiagnostics()
      const draft = buildSupportFeedbackDraft({ summary, diagnostics })
      downloadBlob(new Blob([draft.markdown], { type: "text/markdown;charset=utf-8" }), draft.filename)
      toast.success(t("exported"))
    } catch {
      toast.error(t("exportFailed"))
    } finally {
      setExporting(false)
    }
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline" className="w-full justify-start gap-2">
          <DownloadIcon className="size-4" aria-hidden="true" />
          {t("trigger")}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("title")}</AlertDialogTitle>
          <AlertDialogDescription>{t("description")}</AlertDialogDescription>
        </AlertDialogHeader>
        <Textarea
          value={summary}
          onChange={(event) => setSummary(event.target.value)}
          placeholder={t("placeholder")}
          aria-label={t("summary")}
        />
        <AlertDialogFooter>
          <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
          <AlertDialogAction onClick={() => void confirmExport()} disabled={exporting}>
            {t("confirmExport")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
