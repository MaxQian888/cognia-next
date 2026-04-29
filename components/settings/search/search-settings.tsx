"use client"

import { TooltipProvider } from "@/components/ui/tooltip"
import { SearchGlobalSettings } from "./search-global-settings"
import { SearchDefaultsSettings } from "./search-defaults-settings"
import { SearchCacheSettings } from "./search-cache-settings"
import { SearchSafetySettings } from "./search-safety-settings"
import { SourceVerificationSettings } from "./source-verification-settings"
import { SearchProviderGrid } from "./search-provider-grid"
import { SearchProviderCompare } from "./search-provider-compare"
import { SearchUsagePanel } from "./search-usage-panel"

export function SearchSettings() {
  return (
    <TooltipProvider delayDuration={300}>
      <div className="space-y-4">
        <SearchGlobalSettings />
        <SearchDefaultsSettings />
        <SearchCacheSettings />
        <SearchSafetySettings />
        <SourceVerificationSettings />
        <SearchProviderGrid />
        <SearchProviderCompare />
        <SearchUsagePanel />
      </div>
    </TooltipProvider>
  )
}
