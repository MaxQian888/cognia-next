"use client"

import { useState } from "react"
import { useTranslations, useFormatter } from "next-intl"
import { ArrowDown, ArrowUp } from "lucide-react"
import {
  WEB_READER_IDS,
  REMOTE_WEB_READER_IDS,
  CREDENTIALED_WEB_READER_IDS,
  type WebReaderId,
  type CredentialedWebReaderId,
  type WebReaderSettingsV1,
} from "@cognia/agent-config-types"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
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
import { useSettingsStore } from "@/stores/settings"
import { normalizeWebReaderSettings } from "@/lib/web/reader/reader-settings"
import { testReaderConnection, type ReaderTestResult } from "@/lib/web/reader/reader-test"
import { useSearchSectionNav } from "./search-sections"

export function WebReaderSettings() {
  const t = useTranslations("webReaderSettings")
  const format = useFormatter()
  const store = useSettingsStore()
  const settings = store.settings
  const navigate = useSearchSectionNav()
  const normalized = normalizeWebReaderSettings(settings?.webReader, {
    rowExists: settings != null,
    webTools: settings?.webTools,
  })
  const profile = normalized.effective
  const [pendingChange, setPendingChange] = useState<(() => Promise<void>) | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
  const [testing, setTesting] = useState<Partial<Record<WebReaderId, boolean>>>({})
  const [results, setResults] = useState<Partial<Record<WebReaderId, ReaderTestResult>>>({})
  const fixedReaders: readonly WebReaderId[] = ["direct", "platform", "fxtwitter"]
  const fallbacks = WEB_READER_IDS.filter((id) => !fixedReaders.includes(id)).sort(
    (a, b) => (profile.readers[a]?.priority ?? 0) - (profile.readers[b]?.priority ?? 0)
  )
  const ordered = [...fixedReaders, ...fallbacks]

  const save = async (action: () => Promise<void>) => {
    setSaving(true)
    setSaveFailed(false)
    try {
      await action()
    } catch {
      setSaveFailed(true)
    } finally {
      setSaving(false)
    }
  }
  const change = (action: () => Promise<void>) => {
    if (normalized.source === "unsupported-version" && !confirmed) {
      setPendingChange(() => action)
    } else {
      void save(action)
    }
  }
  const move = (id: WebReaderId, delta: number) => {
    const order = [...ordered]
    const from = order.indexOf(id)
    const to = from + delta
    if (from < fixedReaders.length || to < fixedReaders.length || to >= order.length) return
    ;[order[from], order[to]] = [order[to], order[from]]
    change(() =>
      store.setWebReader({
        ...profile,
        readers: Object.fromEntries(
          order.map((reader, priority) => [
            reader,
            {
              enabled: profile.readers[reader]?.enabled === true,
              priority,
            },
          ])
        ),
      })
    )
  }
  const test = async (id: WebReaderId) => {
    setTesting((old) => ({ ...old, [id]: true }))
    setResults((old) => ({ ...old, [id]: undefined }))
    try {
      // Test through the same host transport and reachability real reads
      // use (native proxy on desktop/mobile, CORS-limited fetch in a browser).
      const { resolveWebToolDeps } = await import("@/lib/claude/plugin-tool-ipc")
      const host = await resolveWebToolDeps()
      const result = await testReaderConnection(id, {
        fetchImpl: host.fetchImpl,
        hostReachable: host.hostReachable,
        allowPrivateHosts: host.allowPrivateHosts,
        credentialFor: (reader) => settings?.searchProviders?.[reader]?.apiKey?.trim() || undefined,
      })
      setResults((old) => ({ ...old, [id]: result }))
    } catch {
      setResults((old) => ({
        ...old,
        [id]: {
          reader: id,
          ok: false,
          reason: "reader-unavailable",
          testedAt: Date.now(),
        },
      }))
    } finally {
      setTesting((old) => ({ ...old, [id]: false }))
    }
  }

  return (
    <div className="space-y-5" data-setting-id="web-reader" id="web-reader">
      <p className="text-sm text-muted-foreground">{t("description")}</p>
      <p className="text-xs text-muted-foreground">{t("hostLimitations")}</p>
      <p className="text-xs text-muted-foreground">{t("priorityDescription")}</p>
      {normalized.source === "unsupported-version" && (
        <p role="note" className="rounded-md border p-3 text-sm">
          {t("unsupportedVersion")}
        </p>
      )}
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="reader-default">{t("defaultReader")}</FieldLabel>
          <NativeSelect
            id="reader-default"
            value={profile.defaultReader}
            disabled={saving}
            onChange={(event) => {
              const value = event.target.value as WebReaderSettingsV1["defaultReader"]
              change(() => store.setWebReaderDefault(value))
            }}
          >
            <NativeSelectOption value="auto">{t("auto")}</NativeSelectOption>
            {WEB_READER_IDS.map((id) => (
              <NativeSelectOption key={id} value={id}>
                {t(`readers.${id}`)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        <Field>
          <FieldLabel htmlFor="reader-fallback">{t("externalFallback")}</FieldLabel>
          <NativeSelect
            id="reader-fallback"
            value={profile.externalFallback}
            disabled={saving}
            onChange={(event) => {
              const value = event.target.value as WebReaderSettingsV1["externalFallback"]
              change(() => store.setWebReaderExternalFallback(value))
            }}
          >
            <NativeSelectOption value="off">{t("fallback.off")}</NativeSelectOption>
            <NativeSelectOption value="configured">{t("fallback.configured")}</NativeSelectOption>
          </NativeSelect>
          <FieldDescription>{t("fallbackDescription")}</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="reader-distillation">{t("distillation")}</FieldLabel>
          <NativeSelect
            id="reader-distillation"
            value={profile.distillation}
            disabled={saving}
            onChange={(event) => {
              const value = event.target.value as WebReaderSettingsV1["distillation"]
              change(() => store.setWebReaderDistillation(value))
            }}
          >
            {(["off", "best-effort", "required"] as const).map((mode) => (
              <NativeSelectOption key={mode} value={mode}>
                {t(`modes.${mode}`)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          {(["off", "best-effort", "required"] as const).map((mode) => (
            <FieldDescription key={mode}>{t(`consequences.${mode}`)}</FieldDescription>
          ))}
        </Field>
      </FieldGroup>
      <ol className="space-y-3" aria-label={t("priorityOrder")}>
        {ordered.map((id, index) => {
          const vendor = (CREDENTIALED_WEB_READER_IDS as readonly string[]).includes(id)
          const available =
            !vendor ||
            Boolean(settings?.searchProviders?.[id as CredentialedWebReaderId]?.apiKey?.trim())
          const name = t(`readers.${id}`)
          const result = results[id]
          return (
            <li key={id} className="space-y-2 rounded-lg border p-3">
              <Field orientation="horizontal">
                <FieldLabel htmlFor={`reader-${id}`}>{name}</FieldLabel>
                <Switch
                  id={`reader-${id}`}
                  checked={profile.readers[id]?.enabled === true}
                  disabled={!available || saving}
                  aria-describedby={`reader-disclosure-${id}${vendor ? ` reader-credential-${id}` : ""}`}
                  onCheckedChange={(enabled) =>
                    change(() => store.setWebReaderEntry(id, { enabled }))
                  }
                />
              </Field>
              <p id={`reader-disclosure-${id}`} className="text-xs text-muted-foreground">
                {id === "direct"
                  ? t("directDisclosure")
                  : id === "platform"
                    ? t("platformDisclosure")
                    : (REMOTE_WEB_READER_IDS as readonly string[]).includes(id)
                      ? t("remoteDisclosure", { vendor: name })
                      : null}
              </p>
              {vendor && (
                <div className="text-xs text-muted-foreground">
                  <p id={`reader-credential-${id}`}>
                    {available
                      ? t("usesSearchKey", { vendor: name })
                      : t("missingSearchKey", { vendor: name })}
                  </p>
                  {!available && (
                    <Button variant="link" size="sm" className="px-0" asChild>
                      <a
                        href={`?section=search&searchSection=providers&focus=search-provider-${id}`}
                        onClick={(event) => {
                          event.preventDefault()
                          navigate("providers", `search-provider-${id}`)
                        }}
                      >
                        {t("configureSearchKey", { vendor: name })}
                      </a>
                    </Button>
                  )}
                  <p>{t("vendorCost")}</p>
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="icon"
                  aria-label={t("moveUp", { reader: name })}
                  disabled={index <= fixedReaders.length || saving}
                  onClick={() => move(id, -1)}
                >
                  <ArrowUp className="size-4" />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  aria-label={t("moveDown", { reader: name })}
                  disabled={index < fixedReaders.length || index === ordered.length - 1 || saving}
                  onClick={() => move(id, 1)}
                >
                  <ArrowDown className="size-4" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!available || testing[id]}
                  aria-label={t("testReaderNamed", { reader: name })}
                  onClick={() => void test(id)}
                >
                  {testing[id] ? t("testing") : t("testReader")}
                </Button>
              </div>
              <div role="status" aria-live="polite" className="text-xs">
                {result && (
                  <>
                    <p>
                      {result.ok ? t("testOk") : t("testFailed")}
                      {result.reason ? ` · ${t("testReason", { reason: result.reason })}` : ""}
                    </p>
                    {result.status !== undefined && (
                      <p>{t("httpStatus", { status: result.status })}</p>
                    )}
                    <p>
                      {t("testedAt", {
                        date: format.dateTime(result.testedAt, {
                          dateStyle: "medium",
                          timeStyle: "medium",
                        }),
                      })}
                    </p>
                  </>
                )}
              </div>
            </li>
          )
        })}
      </ol>
      <p className="text-xs text-muted-foreground">{t("testEvidence")}</p>
      {saveFailed && (
        <p role="status" aria-live="polite" className="text-sm text-destructive">
          {t("saveFailed")}
        </p>
      )}
      <AlertDialog
        open={pendingChange !== null}
        onOpenChange={(open) => {
          if (!open) setPendingChange(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("replaceTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("replaceDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setPendingChange(null)}>
              {t("cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const action = pendingChange
                setPendingChange(null)
                setConfirmed(true)
                if (action) void save(action)
              }}
            >
              {t("replace")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
