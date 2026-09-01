"use client"

/**
 * URL-driven state for `/templates` (`?definition=&tab=&domain=&trust=&scope=&q=`).
 *
 * The Studio and the phone body used to answer different questions from
 * different state. The Studio read `?definition=` and kept its filters in
 * component state. The phone kept a search box and read nothing from the URL at
 * all. So a link that opened one template on the desktop opened the whole
 * catalog on a phone, and narrowing the list was not something you could send
 * anyone.
 *
 * Centralising it here is what `/discover` does for the same reason: two bodies,
 * one set of answers, and a deep link that means the same thing on both.
 *
 * Static export note: any component calling this must sit inside `<Suspense>`,
 * because `useSearchParams()` opts out of static rendering.
 */

import { useCallback, useMemo } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"

import { TEMPLATE_FULL_DOMAINS, TEMPLATE_CATALOG_ONLY_DOMAINS } from "@/lib/templates/contracts"
import type { TemplateDomain, TemplateTrust } from "@/lib/templates/contracts"
import { TEMPLATE_SCOPE_TIERS, type TemplateScopeTier } from "@/lib/templates/scope"

export const TEMPLATE_TABS = ["library", "drafts", "published", "packages", "instances"] as const
export type TemplateTab = (typeof TEMPLATE_TABS)[number]

const TRUSTS: readonly TemplateTrust[] = [
  "built-in",
  "verified-publisher",
  "signed-unknown",
  "unsigned",
]

const DOMAINS: readonly TemplateDomain[] = [
  ...TEMPLATE_FULL_DOMAINS,
  ...TEMPLATE_CATALOG_ONLY_DOMAINS,
]

export interface TemplateRouteState {
  definitionId: string | undefined
  tab: TemplateTab
  query: string
  domain: TemplateDomain | "all"
  trust: TemplateTrust | "all"
  scope: TemplateScopeTier | "all"
  /** How many of the three facets are narrowing the list, for a badge. */
  activeFilterCount: number
  setDefinitionId: (id: string | undefined) => void
  setTab: (tab: TemplateTab) => void
  setQuery: (value: string) => void
  setDomain: (value: TemplateDomain | "all") => void
  setTrust: (value: TemplateTrust | "all") => void
  setScope: (value: TemplateScopeTier | "all") => void
  clearFilters: () => void
}

function oneOf<T extends string>(value: string | null, allowed: readonly T[]): T | undefined {
  return value && (allowed as readonly string[]).includes(value) ? (value as T) : undefined
}

export function useTemplateRouteState(): TemplateRouteState {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const setParams = useCallback(
    (patch: Record<string, string | undefined>) => {
      const next = new URLSearchParams(searchParams?.toString() ?? "")
      for (const [key, value] of Object.entries(patch)) {
        if (value) next.set(key, value)
        else next.delete(key)
      }
      const query = next.toString()
      // `replace`, not `push`: typing in the search box would otherwise put one
      // history entry per keystroke between the user and the page they came
      // from. `scroll: false` keeps a filter change from jumping the list.
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
    },
    [router, pathname, searchParams]
  )

  const domain = oneOf(searchParams?.get("domain") ?? null, DOMAINS) ?? "all"
  const trust = oneOf(searchParams?.get("trust") ?? null, TRUSTS) ?? "all"
  const scope = oneOf(searchParams?.get("scope") ?? null, TEMPLATE_SCOPE_TIERS) ?? "all"

  const activeFilterCount = useMemo(
    () => [domain, trust, scope].filter((value) => value !== "all").length,
    [domain, trust, scope]
  )

  return {
    definitionId: searchParams?.get("definition") ?? undefined,
    tab: oneOf(searchParams?.get("tab") ?? null, TEMPLATE_TABS) ?? "library",
    query: searchParams?.get("q") ?? "",
    domain,
    trust,
    scope,
    activeFilterCount,
    setDefinitionId: (id) => setParams({ definition: id }),
    setTab: (tab) => setParams({ tab: tab === "library" ? undefined : tab }),
    setQuery: (value) => setParams({ q: value || undefined }),
    setDomain: (value) => setParams({ domain: value === "all" ? undefined : value }),
    setTrust: (value) => setParams({ trust: value === "all" ? undefined : value }),
    setScope: (value) => setParams({ scope: value === "all" ? undefined : value }),
    clearFilters: () => setParams({ domain: undefined, trust: undefined, scope: undefined }),
  }
}
