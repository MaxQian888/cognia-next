"use client"

/**
 * GitHub Delivery — Settings section shell.
 *
 * 5-tab layout (Repos / Credentials / Policies / Audit / Usage) mirroring
 * the connections-section pattern. The active tab is reflected to the URL
 * (`?ghTab=...`) so deep-links from elsewhere can land on a specific tab.
 *
 * Phase M4 ships the shell + each tab body. Real data flows (repo CRUD,
 * App credential wizard, audit live-query) land in M4-M5 as the plugin's
 * runtime services come online.
 */

import { useRouter, useSearchParams } from "next/navigation"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ReposTab } from "./tabs/repos-tab"
import { CredentialsTab } from "./tabs/credentials-tab"
import { PoliciesTab } from "./tabs/policies-tab"
import { AuditTab } from "./tabs/audit-tab"
import { UsageTab } from "./tabs/usage-tab"

const TAB_PARAM = "ghTab"

export type GithubDeliveryTabId = "repos" | "credentials" | "policies" | "audit" | "usage"

const TAB_IDS: GithubDeliveryTabId[] = ["repos", "credentials", "policies", "audit", "usage"]

function isTab(v: string | null): v is GithubDeliveryTabId {
  return !!v && (TAB_IDS as string[]).includes(v)
}

export function GithubDeliverySection() {
  const router = useRouter()
  const params = useSearchParams()
  const tab = isTab(params.get(TAB_PARAM)) ? (params.get(TAB_PARAM) as GithubDeliveryTabId) : "repos"

  const setTab = (next: string) => {
    const sp = new URLSearchParams(Array.from(params.entries()))
    sp.set(TAB_PARAM, next)
    router.replace(`?${sp.toString()}`)
  }

  return (
    <div className="space-y-4" data-testid="github-delivery-section">
      <header>
        <h2 className="text-lg font-semibold">GitHub Delivery</h2>
        <p className="text-sm text-muted-foreground">
          AI-driven PR review, Issue → PR loops, and Release automation for your GitHub repos.
        </p>
      </header>

      <Tabs value={tab} onValueChange={setTab} className="space-y-4">
        <TabsList>
          <TabsTrigger value="repos">Repos</TabsTrigger>
          <TabsTrigger value="credentials">Credentials</TabsTrigger>
          <TabsTrigger value="policies">Policies</TabsTrigger>
          <TabsTrigger value="audit">Audit</TabsTrigger>
          <TabsTrigger value="usage">Usage</TabsTrigger>
        </TabsList>
        <TabsContent value="repos">
          <ReposTab />
        </TabsContent>
        <TabsContent value="credentials">
          <CredentialsTab />
        </TabsContent>
        <TabsContent value="policies">
          <PoliciesTab />
        </TabsContent>
        <TabsContent value="audit">
          <AuditTab />
        </TabsContent>
        <TabsContent value="usage">
          <UsageTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}
