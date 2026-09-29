"use client"

import { FileUpIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { useEffect, useState } from "react"
import { open as openDialog } from "@tauri-apps/plugin-dialog"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  importPasswordsFromBrowser,
  importPasswordsFromCsv,
  listPasswordSources,
  PASSWORD_CSV_FORMATS,
  type PasswordCsvFormat,
  type PasswordImportResult,
  type PasswordSource,
} from "@/lib/browser/passwords"

const PRIMARY_PASSWORD_SET = "primary_password_set"

function ImportResultView({ result }: { result: PasswordImportResult }) {
  const t = useTranslations("browserVault.passwords.import")
  const primaryPasswordSet = result.errors.some((error) => error.includes(PRIMARY_PASSWORD_SET))
  const otherErrors = result.errors.filter((error) => !error.includes(PRIMARY_PASSWORD_SET))
  return (
    <div role="status" className="grid gap-2 text-sm" data-testid="password-import-result">
      <p>
        {t("result", {
          imported: result.imported,
          updated: result.updated,
          skipped: result.skipped,
        })}
      </p>
      {result.skippedAppBound > 0 && (
        <Alert>
          <AlertDescription>{t("appBound", { count: result.skippedAppBound })}</AlertDescription>
        </Alert>
      )}
      {primaryPasswordSet && (
        <Alert variant="destructive">
          <AlertDescription>{t("primaryPasswordSet")}</AlertDescription>
        </Alert>
      )}
      {otherErrors.length > 0 && (
        <p className="text-destructive">{t("errors", { count: otherErrors.length })}</p>
      )}
    </div>
  )
}

function BrowserImportTab({ onImported }: { onImported: () => void }) {
  const t = useTranslations("browserVault")
  const [sources, setSources] = useState<PasswordSource[] | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [browser, setBrowser] = useState("")
  const [profile, setProfile] = useState("")
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<PasswordImportResult | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    listPasswordSources()
      .then((next) => {
        if (cancelled) return
        setSources(next)
        const first = next.find((source) => source.supported && source.profiles.length > 0)
        if (first) {
          setBrowser(first.browser)
          setProfile(first.profiles[0]?.id ?? "")
        }
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (loadFailed) {
    return <p className="text-sm text-destructive">{t("common.failed")}</p>
  }
  if (!sources) {
    return (
      <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner />
        {t("common.loading")}
      </p>
    )
  }
  const usable = sources.filter((source) => source.supported && source.profiles.length > 0)
  if (usable.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("passwords.import.noSources")}</p>
  }
  const selected = sources.find((source) => source.browser === browser)
  const reasonLabel = (reason: string | null | undefined) => {
    const key = `passwords.import.reason.${reason}`
    return reason && t.has(key) ? t(key) : null
  }

  const run = async () => {
    if (!browser || !profile || running) return
    setRunning(true)
    setFailed(false)
    setResult(null)
    try {
      const next = await importPasswordsFromBrowser(browser, profile)
      setResult(next)
      onImported()
    } catch {
      setFailed(true)
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="grid gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid min-w-0 gap-1.5 text-sm">
          <span>{t("passwords.import.source")}</span>
          <NativeSelect
            value={browser}
            wrapperClassName="w-full"
            onChange={(event) => {
              const next = sources.find((source) => source.browser === event.target.value)
              setBrowser(event.target.value)
              setProfile(next?.profiles[0]?.id ?? "")
              setResult(null)
            }}
          >
            {sources.map((source) => {
              const reason = source.supported ? null : reasonLabel(source.reason)
              return (
                <NativeSelectOption
                  key={source.browser}
                  value={source.browser}
                  disabled={!source.supported || source.profiles.length === 0}
                >
                  {reason
                    ? t("passwords.import.sourceWithReason", { label: source.label, reason })
                    : source.label}
                </NativeSelectOption>
              )
            })}
          </NativeSelect>
        </label>
        <label className="grid min-w-0 gap-1.5 text-sm">
          <span>{t("passwords.import.profile")}</span>
          <NativeSelect
            value={profile}
            wrapperClassName="w-full"
            onChange={(event) => {
              setProfile(event.target.value)
              setResult(null)
            }}
          >
            {(selected?.profiles ?? []).map((candidate) => (
              <NativeSelectOption key={candidate.id} value={candidate.id}>
                {candidate.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
      </div>
      <Button
        size="sm"
        className="justify-self-end"
        disabled={!profile || running}
        onClick={() => void run()}
      >
        {running ? t("passwords.import.importing") : t("passwords.import.run")}
      </Button>
      {failed && (
        <p role="alert" className="text-sm text-destructive">
          {t("passwords.import.failed")}
        </p>
      )}
      {result && <ImportResultView result={result} />}
    </div>
  )
}

function CsvImportTab({ onImported }: { onImported: () => void }) {
  const t = useTranslations("browserVault")
  const [format, setFormat] = useState<PasswordCsvFormat | "auto">("auto")
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<PasswordImportResult | null>(null)
  const [failed, setFailed] = useState(false)

  const run = async () => {
    if (running) return
    setFailed(false)
    try {
      const picked = await openDialog({
        multiple: false,
        directory: false,
        filters: [{ name: t("passwords.import.fileFilter"), extensions: ["csv"] }],
      })
      const path = Array.isArray(picked) ? picked[0] : picked
      if (!path) return
      setRunning(true)
      setResult(null)
      const next = await importPasswordsFromCsv(path, format === "auto" ? undefined : format)
      setResult(next)
      onImported()
    } catch {
      setFailed(true)
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="grid gap-3">
      <label className="grid min-w-0 gap-1.5 text-sm">
        <span>{t("passwords.import.format")}</span>
        <NativeSelect
          value={format}
          wrapperClassName="w-full"
          onChange={(event) => setFormat(event.target.value as PasswordCsvFormat | "auto")}
        >
          <NativeSelectOption value="auto">{t("passwords.import.formats.auto")}</NativeSelectOption>
          {PASSWORD_CSV_FORMATS.map((candidate) => (
            <NativeSelectOption key={candidate} value={candidate}>
              {t(`passwords.import.formats.${candidate}`)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </label>
      <Button size="sm" className="justify-self-end" disabled={running} onClick={() => void run()}>
        {running ? <Spinner /> : <FileUpIcon />}
        {running ? t("passwords.import.importing") : t("passwords.import.chooseFile")}
      </Button>
      {failed && (
        <p role="alert" className="text-sm text-destructive">
          {t("passwords.import.failed")}
        </p>
      )}
      {result && <ImportResultView result={result} />}
    </div>
  )
}

/**
 * Import saved passwords from another browser profile on this device or from a
 * CSV export (ADR-0201). Rust reads and stores the values; this dialog only
 * sees counts and error codes, including the App-Bound skip count and the
 * Firefox `primary_password_set` refusal, both explained in place.
 */
export function BrowserPasswordImportDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onImported: () => void
}) {
  const t = useTranslations("browserVault.passwords.import")
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="browser">
          <TabsList>
            <TabsTrigger value="browser">{t("browserTab")}</TabsTrigger>
            <TabsTrigger value="csv">{t("csvTab")}</TabsTrigger>
          </TabsList>
          <TabsContent value="browser" className="pt-3">
            <BrowserImportTab onImported={onImported} />
          </TabsContent>
          <TabsContent value="csv" className="pt-3">
            <CsvImportTab onImported={onImported} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
