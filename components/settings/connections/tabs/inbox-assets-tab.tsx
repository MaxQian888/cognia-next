"use client"

import { useTranslations } from "next-intl"

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { CannedResponsesTab } from "./canned-responses-tab"
import { LabelsTab } from "./labels-tab"

export function InboxAssetsTab() {
  const t = useTranslations("settings.connections.inboxAssets")
  return (
    <div className="space-y-4" data-testid="inbox-assets-tab">
      <p className="text-xs text-muted-foreground">{t("description")}</p>
      <Tabs defaultValue="labels">
        <TabsList>
          <TabsTrigger value="labels">{t("labels")}</TabsTrigger>
          <TabsTrigger value="canned">{t("cannedResponses")}</TabsTrigger>
        </TabsList>
        <TabsContent value="labels">
          <LabelsTab />
        </TabsContent>
        <TabsContent value="canned">
          <CannedResponsesTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}
