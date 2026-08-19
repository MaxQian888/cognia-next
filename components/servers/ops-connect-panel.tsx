"use client"

/**
 * The `/servers` entry screen while no controller is connected.
 *
 * Deliberately states the transport up front. On the web shell the request
 * leaves the browser and only arrives if the controller opts into CORS, and a
 * user who has not been told that reads the resulting failure as "the app is
 * broken" rather than "this shell cannot reach a self-hosted controller".
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { PlugZapIcon, ServerCogIcon, ShieldCheckIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { useServerOps } from "./ops-context"

/**
 * Mirror of the client's `normalizeControllerUrl` rule, run before submit so
 * the operator sees which field is wrong instead of a generic connect failure.
 */
function controllerUrlProblem(value: string): "invalid" | "insecure" | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return "invalid"
  }
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)
  if (url.protocol === "https:") return null
  if (url.protocol === "http:" && loopback) return null
  return "insecure"
}

export function OpsConnectPanel() {
  const t = useTranslations("servers")
  const { connect, connecting, transport } = useServerOps()
  const [controllerUrl, setControllerUrl] = useState("")
  const [profileId, setProfileId] = useState("default")
  const [accessToken, setAccessToken] = useState("")
  const [touched, setTouched] = useState(false)

  const urlProblem = controllerUrl.trim() ? controllerUrlProblem(controllerUrl.trim()) : null
  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setTouched(true)
    if (urlProblem || !profileId.trim() || !accessToken) return
    const ok = await connect({
      controllerUrl: controllerUrl.trim(),
      profileId: profileId.trim(),
      accessToken,
    })
    // Cleared either way: a rejected token is not worth keeping in a field the
    // next attempt would resubmit unchanged.
    setAccessToken("")
    if (ok) setTouched(false)
  }

  return (
    <div className="flex h-full w-full items-start justify-center overflow-y-auto p-4 md:items-center">
      <section className="w-full max-w-lg py-6">
        <div className="flex items-center gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-lg border bg-background">
            <ServerCogIcon className="size-5 text-muted-foreground" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h1 className="text-lg font-semibold tracking-tight">{t("connection.title")}</h1>
            <p className="text-sm text-muted-foreground">{t("connection.description")}</p>
          </div>
        </div>

        {transport === "browser" && (
          <Alert className="mt-5">
            <PlugZapIcon className="size-4" aria-hidden="true" />
            <AlertTitle>{t("connection.browserTransportTitle")}</AlertTitle>
            <AlertDescription>{t("connection.browserTransport")}</AlertDescription>
          </Alert>
        )}

        <form onSubmit={submit} className="mt-6 space-y-5">
          <FieldGroup>
            <Field data-invalid={touched && Boolean(urlProblem) ? true : undefined}>
              <FieldLabel htmlFor="ops-controller-url">{t("connection.controllerUrl")}</FieldLabel>
              <Input
                id="ops-controller-url"
                type="text"
                inputMode="url"
                required
                autoComplete="off"
                value={controllerUrl}
                aria-invalid={touched && Boolean(urlProblem)}
                onChange={(event) => setControllerUrl(event.target.value)}
                placeholder={t("connection.controllerPlaceholder")}
              />
              <FieldDescription>
                {touched && urlProblem
                  ? t(`connection.urlProblem.${urlProblem}`)
                  : t("connection.controllerUrlHelp")}
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="ops-profile-id">{t("connection.profileId")}</FieldLabel>
              <Input
                id="ops-profile-id"
                required
                autoComplete="off"
                value={profileId}
                onChange={(event) => setProfileId(event.target.value)}
              />
              <FieldDescription>{t("connection.profileIdHelp")}</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="ops-access-token">{t("connection.accessToken")}</FieldLabel>
              <Input
                id="ops-access-token"
                type="password"
                required
                autoComplete="off"
                value={accessToken}
                onChange={(event) => setAccessToken(event.target.value)}
              />
              <FieldDescription>{t("connection.tokenNotice")}</FieldDescription>
            </Field>
          </FieldGroup>
          <Button type="submit" className="w-full" disabled={connecting}>
            {connecting && <Spinner />}
            {connecting ? t("connection.connecting") : t("connection.connect")}
          </Button>
        </form>

        <p className="mt-5 flex items-start gap-2 border-t pt-4 text-xs text-muted-foreground">
          <ShieldCheckIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          {t("connection.storageNotice")}
        </p>
      </section>
    </div>
  )
}
