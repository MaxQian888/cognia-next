/** Renderer binding for the host-independent configured search policy. */

import type { SearchResponse } from "@cognia/web-search/types"

import { searchWithSettings, type ConfiguredSearchRequest } from "./configured-search-core"
import "./search-service"
import { useSettingsStore } from "@/stores/settings"

export type AppSearchRequest = ConfiguredSearchRequest

/** Execute one search using an explicit settings snapshot or the live app settings. */
export function searchWithAppSettings(
  rawQuery: string,
  request: AppSearchRequest = {}
): Promise<SearchResponse> {
  return searchWithSettings(rawQuery, {
    ...request,
    settings: request.settings ?? useSettingsStore.getState().settings ?? undefined,
  })
}
