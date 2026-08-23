"use client"

import { useMemo, useState, useSyncExternalStore } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import { CableIcon, GlobeIcon, PauseIcon, PlayIcon, PlusIcon } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  getExternalServiceCatalogRevision,
  listExternalServices,
  subscribeExternalServiceCatalog,
} from "@/lib/external-services/catalog"
import {
  listServiceConnections,
  resumePluginServiceConnections,
  updateServiceConnectionStatus,
} from "@/lib/db/external-services"
import { connectBrowserSite } from "@/lib/external-services/providers/browser"
import type { ServiceConnection } from "@/types/external-service"

const INSTALL_STEPS = ["install", "connect", "discover", "validate", "enable", "manage"] as const

export function ExternalServicesSection() {
  const t = useTranslations("settings.externalServices")
  const catalogRevision = useSyncExternalStore(
    subscribeExternalServiceCatalog,
    getExternalServiceCatalogRevision,
    getExternalServiceCatalogRevision
  )
  const connections = useLiveQuery(() => listServiceConnections(), [], [])
  const services = useMemo(() => {
    void catalogRevision
    return listExternalServices()
  }, [catalogRevision])
  const [dialogOpen, setDialogOpen] = useState(false)
  const [name, setName] = useState("")
  const [domains, setDomains] = useState("")
  const [loginStartUrl, setLoginStartUrl] = useState("")
  const [allowUploads, setAllowUploads] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const connectedServiceKeys = new Set(
    connections.map((connection) => `${connection.pluginId ?? "user"}:${connection.serviceId}`)
  )
  const availableServices = services.filter(
    (service) => !connectedServiceKeys.has(`${service.pluginId}:${service.definition.id}`)
  )

  const resetForm = () => {
    setName("")
    setDomains("")
    setLoginStartUrl("")
    setAllowUploads(false)
  }

  const submitWebsite = async () => {
    setSubmitting(true)
    try {
      await connectBrowserSite({
        name,
        domains: domains
          .split(",")
          .map((domain) => domain.trim())
          .filter(Boolean),
        runtimeTargetId: "local",
        loginStartUrl: loginStartUrl.trim() || undefined,
        allowUploads,
      })
      toast.success(t("website.connected"))
      resetForm()
      setDialogOpen(false)
    } catch (error) {
      toast.error(
        t("website.failed", { reason: error instanceof Error ? error.message : String(error) })
      )
    } finally {
      setSubmitting(false)
    }
  }

  const toggleConnection = async (connection: ServiceConnection) => {
    if (connection.status === "suspended") {
      if (connection.pluginId && connection.pluginId !== "user") {
        await resumePluginServiceConnections(connection.pluginId)
      } else {
        await updateServiceConnectionStatus(
          connection.id,
          connection.suspendedFromStatus ?? "pending"
        )
      }
    } else {
      await updateServiceConnectionStatus(connection.id, "suspended")
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <CableIcon className="size-5" />
            {t("title")}
          </h2>
          <p className="max-w-3xl text-sm text-muted-foreground">{t("description")}</p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button>
              <PlusIcon className="mr-2 size-4" />
              {t("website.connect")}
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("website.title")}</DialogTitle>
              <DialogDescription>{t("website.description")}</DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="external-service-name">{t("website.name")}</Label>
                <Input
                  id="external-service-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={t("website.namePlaceholder")}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="external-service-domains">{t("website.domains")}</Label>
                <Input
                  id="external-service-domains"
                  value={domains}
                  onChange={(event) => setDomains(event.target.value)}
                  placeholder={t("website.domainsPlaceholder")}
                />
                <p className="text-xs text-muted-foreground">{t("website.domainsHint")}</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="external-service-login">{t("website.loginUrl")}</Label>
                <Input
                  id="external-service-login"
                  value={loginStartUrl}
                  onChange={(event) => setLoginStartUrl(event.target.value)}
                  placeholder={t("website.loginUrlPlaceholder")}
                />
              </div>
              <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
                <div>
                  <Label htmlFor="external-service-uploads">{t("website.uploads")}</Label>
                  <p className="text-xs text-muted-foreground">{t("website.uploadsHint")}</p>
                </div>
                <Switch
                  id="external-service-uploads"
                  checked={allowUploads}
                  onCheckedChange={setAllowUploads}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDialogOpen(false)}>
                {t("actions.cancel")}
              </Button>
              <Button
                onClick={submitWebsite}
                disabled={submitting || !name.trim() || !domains.trim()}
              >
                {submitting ? t("actions.connecting") : t("actions.create")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <ol className="grid gap-2 md:grid-cols-3 xl:grid-cols-6" aria-label={t("flow.ariaLabel")}>
        {INSTALL_STEPS.map((step, index) => (
          <li key={step} className="rounded-lg border bg-muted/20 p-3 text-xs">
            <span className="text-muted-foreground">{index + 1}</span>
            <p className="mt-1 font-medium">{t(`flow.${step}`)}</p>
          </li>
        ))}
      </ol>

      <section className="space-y-3" aria-labelledby="service-connections-heading">
        <h3 id="service-connections-heading" className="text-sm font-semibold">
          {t("connections.title")}
        </h3>
        {connections.length === 0 ? (
          <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
            {t("connections.empty")}
          </p>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {connections.map((connection) => (
              <ConnectionCard
                key={connection.id}
                connection={connection}
                onToggle={() => void toggleConnection(connection)}
              />
            ))}
          </div>
        )}
      </section>

      {availableServices.length > 0 && (
        <section className="space-y-3" aria-labelledby="available-services-heading">
          <h3 id="available-services-heading" className="text-sm font-semibold">
            {t("available.title")}
          </h3>
          <div className="grid gap-3 lg:grid-cols-2">
            {availableServices.map((service) => (
              <Card key={`${service.pluginId}:${service.definition.id}`}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">{service.definition.label}</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-wrap gap-1.5">
                  {service.definition.providers.map((provider) => (
                    <Badge key={provider.id} variant="secondary">
                      {provider.kind} · {t(`availability.${provider.availability ?? "supported"}`)}
                    </Badge>
                  ))}
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

function ConnectionCard({
  connection,
  onToggle,
}: {
  connection: ServiceConnection
  onToggle: () => void
}) {
  const t = useTranslations("settings.externalServices")
  const suspended = connection.status === "suspended"
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-sm">
              {connection.providerRef.kind === "browser" && <GlobeIcon className="size-4" />}
              {connection.accountLabel ?? connection.serviceId}
            </CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("connections.provider", { provider: connection.providerRef.kind })}
            </p>
          </div>
          <Badge variant={connection.status === "connected" ? "default" : "secondary"}>
            {t(`status.${connection.status}`)}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="flex items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1">
          {connection.enabledSurfaces.map((surface) => (
            <Badge key={surface} variant="outline">
              {t(`surface.${surface}`)}
            </Badge>
          ))}
        </div>
        <Button variant="outline" size="sm" onClick={onToggle}>
          {suspended ? (
            <PlayIcon className="mr-1 size-3.5" />
          ) : (
            <PauseIcon className="mr-1 size-3.5" />
          )}
          {suspended ? t("actions.resume") : t("actions.pause")}
        </Button>
      </CardContent>
    </Card>
  )
}
