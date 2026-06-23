"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { GitCompare, Loader2, ExternalLink, Clock, FileText } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useSettingsStore } from "@/stores/settings"
import { search } from "@/lib/search/search-service"
import {
  type SearchProviderType,
  SEARCH_PROVIDERS,
  isProviderConfigured,
  DEFAULT_SEARCH_PROVIDER_SETTINGS,
} from "@/lib/search/types"
import type { SearchResponse } from "@/lib/search/types"
import { createLogger } from "@/lib/logging"

const log = createLogger("settings.search.compare")

export function SearchProviderCompare() {
  const tc = useTranslations("searchSettings.compare")
  const [query, setQuery] = useState("")
  const [providerA, setProviderA] = useState<SearchProviderType>("tavily")
  const [providerB, setProviderB] = useState<SearchProviderType>("brave")
  const [loading, setLoading] = useState(false)
  const [resultA, setResultA] = useState<SearchResponse | null>(null)
  const [resultB, setResultB] = useState<SearchResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  const providerSettings = useSettingsStore(
    (s) => s.settings?.searchProviders ?? DEFAULT_SEARCH_PROVIDER_SETTINGS
  )

  const configuredProviders = Object.entries(providerSettings)
    .filter(([id]) =>
      isProviderConfigured(id as SearchProviderType, providerSettings[id as SearchProviderType])
    )
    .map(([id]) => id)

  const handleCompare = async () => {
    if (!query.trim() || loading) return
    setLoading(true)
    setError(null)
    setResultA(null)
    setResultB(null)

    log.info("compare_started", {
      providerA,
      providerB,
      queryLen: query.trim().length,
    })

    try {
      const [a, b] = await Promise.all([
        search(query, { provider: providerA, providerSettings, fallbackEnabled: false }),
        search(query, { provider: providerB, providerSettings, fallbackEnabled: false }),
      ])
      setResultA(a)
      setResultB(b)
      log.info("compare_succeeded", {
        providerA,
        providerB,
        aResults: a.results.length,
        bResults: b.results.length,
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : "Comparison failed")
      log.error("compare_failed", e, { providerA, providerB })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label className="text-xs">{tc("query")}</Label>
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={tc("queryPlaceholder")}
          className="h-8 text-sm"
          onKeyDown={(e) => e.key === "Enter" && handleCompare()}
        />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-xs">{tc("providerA")}</Label>
          <Select value={providerA} onValueChange={(v) => setProviderA(v as SearchProviderType)}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {configuredProviders.map((id) => (
                <SelectItem key={id} value={id} className="text-xs">
                  {SEARCH_PROVIDERS[id as SearchProviderType]?.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">{tc("providerB")}</Label>
          <Select value={providerB} onValueChange={(v) => setProviderB(v as SearchProviderType)}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {configuredProviders.map((id) => (
                <SelectItem key={id} value={id} className="text-xs">
                  {SEARCH_PROVIDERS[id as SearchProviderType]?.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <Button
        onClick={handleCompare}
        disabled={!query.trim() || loading}
        size="sm"
        className="w-full"
      >
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin mr-1" />
        ) : (
          <GitCompare className="h-4 w-4 mr-1" />
        )}
        {tc("compare")}
      </Button>

      {error && <p className="text-xs text-destructive">{error}</p>}

      {(resultA || resultB) && (
        <div className="grid grid-cols-1 gap-3 pt-2 border-t sm:grid-cols-2">
          <CompareResultColumn providerId={providerA} result={resultA} t={tc} />
          <CompareResultColumn providerId={providerB} result={resultB} t={tc} />
        </div>
      )}
    </div>
  )
}

function CompareResultColumn({
  providerId,
  result,
  t,
}: {
  providerId: string
  result: SearchResponse | null
  t: (key: string) => string
}) {
  const name = SEARCH_PROVIDERS[providerId as SearchProviderType]?.name || providerId

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium">{name}</span>
        {result && (
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
            <span className="flex items-center gap-0.5">
              <FileText className="h-3 w-3" />
              {result.results.length}
            </span>
            <span className="flex items-center gap-0.5">
              <Clock className="h-3 w-3" />
              {result.responseTime}ms
            </span>
          </div>
        )}
      </div>
      {result ? (
        <div className="space-y-1.5">
          {result.results.slice(0, 5).map((r, i) => (
            <div key={i} className="rounded border p-2">
              <p className="text-xs font-medium line-clamp-1">{r.title}</p>
              <p className="text-[10px] text-muted-foreground line-clamp-1">{r.content}</p>
              <a
                href={r.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[10px] text-primary hover:underline flex items-center gap-0.5 mt-0.5"
              >
                {(() => {
                  try {
                    return new URL(r.url).hostname
                  } catch {
                    return r.url
                  }
                })()}
                <ExternalLink className="h-2.5 w-2.5" />
              </a>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{t("noResult")}</p>
      )}
    </div>
  )
}
