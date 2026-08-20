"use client"

/**
 * Where a user says which diagnostic service their crash reports go to.
 *
 * Nothing else in the app could answer that question, which is why the `/logs`
 * consent panel had no submit button and the triage console had nowhere to
 * connect. The shape mirrors `/servers`' connect panel (ADR-0059) because it is
 * the same problem: a user-entered host, a secret that belongs in the OS
 * keyring, and a shell that may not be able to reach the host at all.
 *
 * The identity session is optional on purpose. A desktop install submits its
 * own crashes with an installation proof and needs no token; a token is what
 * promotes the connection from "can upload my own crashes" to "can triage
 * everyone's", and the card says which of the two this connection is.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { CheckCircle2Icon, PlugZapIcon, TriangleAlertIcon, UnplugIcon } from "lucide-react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { useDiagnosticConnection } from "@/hooks/diagnostic-service/use-diagnostic-connection"
import { normalizeServiceUrl } from "@/lib/diagnostic-service/client"
import { canSubmitDiagnostics } from "@/lib/native/diagnostic-submit"

/** A tenant/project id has to be a UUID — the service will refuse anything else. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function DiagnosticServiceCard() {
  const t = useTranslations("settings.diagnostics.service")
  // No injection seam: a conditional hook call would be a rules-of-hooks
  // violation, and the connection hook reaches the account store. The test
  // mocks the module instead, the way `diagnostics-workspace.test.tsx` does.
  const service = useDiagnosticConnection()
  const desktop = canSubmitDiagnostics()

  const [baseUrl, setBaseUrl] = useState("")
  const [tenantId, setTenantId] = useState("")
  const [projectId, setProjectId] = useState("")
  const [sessionToken, setSessionToken] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // Seed the form from the stored connection once it has loaded. Guarded so a
  // later re-render cannot clobber what the user is typing.
  const [seeded, setSeeded] = useState(false)
  useEffect(() => {
    if (seeded || service.loading) return
    void Promise.resolve().then(() => {
      setBaseUrl(service.connection?.baseUrl ?? "")
      setTenantId(service.connection?.tenantId ?? "")
      setProjectId(service.connection?.projectId ?? "")
      setSeeded(true)
    })
  }, [seeded, service.connection, service.loading])

  const submit = async () => {
    setError(null)
    let normalized: string
    try {
      normalized = normalizeServiceUrl(baseUrl)
    } catch {
      setError("url")
      return
    }
    if (!UUID.test(tenantId.trim()) || !UUID.test(projectId.trim())) {
      setError("ids")
      return
    }
    setSaving(true)
    try {
      await service.connect({
        baseUrl: normalized,
        tenantId: tenantId.trim(),
        projectId: projectId.trim(),
        // Reused as the uploader identity for shells that cannot mint their
        // own; the desktop overrides it with its key-derived id.
        installationId: service.connection?.installationId ?? "",
        autoSubmit: service.connection?.autoSubmit ?? false,
        lastKnownRole: service.connection?.lastKnownRole ?? null,
        sessionToken: sessionToken.trim() || undefined,
      })
      setSessionToken("")
    } catch {
      setError("save")
    } finally {
      setSaving(false)
    }
  }

  const connected = Boolean(service.connection)

  return (
    <Card data-testid="diagnostic-service-card">
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle>{t("title")}</CardTitle>
            <CardDescription>{t("description")}</CardDescription>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {connected ? (
              <Badge variant="secondary">
                <CheckCircle2Icon className="size-3" />
                {t("connected")}
              </Badge>
            ) : (
              <Badge variant="outline">{t("disconnected")}</Badge>
            )}
            {service.role && <Badge variant="outline">{t(`roles.${service.role}`)}</Badge>}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {!service.reachable && (
          <Alert data-testid="diagnostic-service-unreachable">
            <TriangleAlertIcon className="size-4" />
            <AlertDescription>{t("browserTransport")}</AlertDescription>
          </Alert>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="diagnostic-service-url">{t("url")}</Label>
            <Input
              id="diagnostic-service-url"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://diagnostics.example.com"
              autoComplete="off"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="diagnostic-service-tenant">{t("tenantId")}</Label>
            <Input
              id="diagnostic-service-tenant"
              value={tenantId}
              onChange={(event) => setTenantId(event.target.value)}
              autoComplete="off"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="diagnostic-service-project">{t("projectId")}</Label>
            <Input
              id="diagnostic-service-project"
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
              autoComplete="off"
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="diagnostic-service-token">{t("sessionToken")}</Label>
            <Input
              id="diagnostic-service-token"
              type="password"
              value={sessionToken}
              onChange={(event) => setSessionToken(event.target.value)}
              placeholder={service.authenticated ? t("sessionStored") : t("sessionOptional")}
              autoComplete="off"
            />
            <p className="text-xs text-muted-foreground">{t("sessionDescription")}</p>
          </div>
        </div>

        {error && (
          <Alert variant="destructive" data-testid="diagnostic-service-error">
            <AlertDescription>{t(`errors.${error}`)}</AlertDescription>
          </Alert>
        )}

        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => void submit()} disabled={saving}>
            <PlugZapIcon className="size-4" />
            {connected ? t("update") : t("connect")}
          </Button>
          {connected && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void service.disconnect()}
              disabled={saving}
              data-testid="diagnostic-service-disconnect"
            >
              <UnplugIcon className="size-4" />
              {t("disconnect")}
            </Button>
          )}
        </div>

        {connected && desktop && (
          <label className="flex items-start gap-2 rounded-md border p-3">
            <Switch
              checked={service.connection?.autoSubmit ?? false}
              onCheckedChange={(checked) =>
                void service.connect({
                  ...service.connection!,
                  autoSubmit: checked,
                })
              }
              aria-label={t("autoSubmit")}
            />
            <span>
              <span className="font-medium">{t("autoSubmit")}</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {t("autoSubmitDescription")}
              </span>
            </span>
          </label>
        )}
      </CardContent>
    </Card>
  )
}
