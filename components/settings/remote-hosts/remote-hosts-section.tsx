"use client"

/**
 * Settings → Remote hosts (ADR-0082, R0). Desktop-only. Tabs: Hosts (the
 * registry + which one is driving the app) and Add host (pairing).
 *
 * The active tab lives in the URL `?remoteHostsTab=` param, matching every
 * other tabbed settings section. Pairing on the Add tab switches to Hosts.
 */

import { useTranslations } from "next-intl"
import { useRouter, useSearchParams } from "next/navigation"
import { ServerIcon } from "lucide-react"

import { Label } from "@/components/ui/label"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

import { AddHostTab } from "./tabs/add-host-tab"
import { HostsTab } from "./tabs/hosts-tab"

const REMOTE_HOSTS_TAB_PARAM = "remoteHostsTab"

export type RemoteHostsTabId = "hosts" | "add"
const TAB_IDS: RemoteHostsTabId[] = ["hosts", "add"]

function isRemoteHostsTab(value: string | null): value is RemoteHostsTabId {
  return !!value && (TAB_IDS as string[]).includes(value)
}

export function RemoteHostsSection() {
  const t = useTranslations("settings.remoteHosts")
  const router = useRouter()
  const searchParams = useSearchParams()
  const requested = searchParams.get(REMOTE_HOSTS_TAB_PARAM)
  const activeTab: RemoteHostsTabId = isRemoteHostsTab(requested) ? requested : "hosts"

  const setTab = (value: string) => {
    if (!isRemoteHostsTab(value)) return
    const next = new URLSearchParams(searchParams.toString())
    next.set(REMOTE_HOSTS_TAB_PARAM, value)
    router.replace(`?${next.toString()}`, { scroll: false })
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Label className="flex items-center gap-2">
          <ServerIcon className="size-4" />
          {t("title")}
        </Label>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>

      <Tabs value={activeTab} onValueChange={setTab}>
        <div className="-mx-1 overflow-x-auto px-1">
          <TabsList className="w-max">
            <TabsTrigger value="hosts">{t("tabs.hosts")}</TabsTrigger>
            <TabsTrigger value="add">{t("tabs.add")}</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="hosts" className="mt-4">
          <HostsTab />
        </TabsContent>
        <TabsContent value="add" className="mt-4">
          <AddHostTab onPaired={() => setTab("hosts")} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
