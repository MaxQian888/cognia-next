"use client"

/**
 * The three template facets, as a bottom sheet.
 *
 * The phone had a search box and nothing else, while the desktop Studio offered
 * domain, trust and now scope. So a phone could find a template by name and
 * could not narrow the list at all: on a catalog carrying built-ins, plugin
 * contributions and everything the user has forked, that is the difference
 * between a library and a scroll.
 *
 * A sheet rather than three selects in the header, which is the pattern the
 * platform guidance and the rest of this app already use on compact widths, and
 * it keeps the list itself full-height.
 */

import { useTranslations } from "next-intl"
import { SlidersHorizontalIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type { TemplateDomain, TemplateTrust } from "@/lib/templates/contracts"
import { TEMPLATE_SCOPE_TIERS, type TemplateScopeTier } from "@/lib/templates/scope"
import type { TemplateRouteState } from "@/hooks/templates/use-template-route-state"

const TRUSTS: readonly TemplateTrust[] = [
  "built-in",
  "verified-publisher",
  "signed-unknown",
  "unsigned",
]

export interface TemplatesFilterSheetProps {
  route: TemplateRouteState
  /** Only the domains actually present, so the sheet never offers an empty one. */
  domains: readonly TemplateDomain[]
}

export function TemplatesFilterSheet({ route, domains }: TemplatesFilterSheetProps) {
  const t = useTranslations("templateStudio")

  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="outline" size="icon" aria-label={t("filters.title")}>
          <SlidersHorizontalIcon className="size-4" />
          {route.activeFilterCount > 0 ? (
            <Badge
              className="absolute -right-1 -top-1 size-4 justify-center p-0 text-[10px]"
              data-testid="templates-filter-count"
            >
              {route.activeFilterCount}
            </Badge>
          ) : null}
        </Button>
      </SheetTrigger>
      <SheetContent side="bottom" className="max-h-[80svh] overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{t("filters.title")}</SheetTitle>
        </SheetHeader>
        <div className="space-y-4 px-4 pb-6">
          <FacetGroup
            label={t("filters.scope")}
            allLabel={t("filters.allScopes")}
            value={route.scope}
            options={TEMPLATE_SCOPE_TIERS.map((tier) => ({
              value: tier,
              label: t(`scopes.${tier}`),
            }))}
            onChange={(value) => route.setScope(value as TemplateScopeTier | "all")}
            testId="templates-filter-scope"
          />
          <FacetGroup
            label={t("filters.domain")}
            allLabel={t("filters.allDomains")}
            value={route.domain}
            options={domains.map((domain) => ({
              value: domain,
              label: t(`domains.${domain}`),
            }))}
            onChange={(value) => route.setDomain(value as TemplateDomain | "all")}
            testId="templates-filter-domain"
          />
          <FacetGroup
            label={t("filters.trust")}
            allLabel={t("filters.allTrust")}
            value={route.trust}
            options={TRUSTS.map((trust) => ({ value: trust, label: t(`trust.${trust}`) }))}
            onChange={(value) => route.setTrust(value as TemplateTrust | "all")}
            testId="templates-filter-trust"
          />
          {route.activeFilterCount > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={route.clearFilters}
              data-testid="templates-filter-clear"
            >
              {t("filters.clear")}
            </Button>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function FacetGroup({
  label,
  allLabel,
  value,
  options,
  onChange,
  testId,
}: {
  label: string
  allLabel: string
  value: string
  options: { value: string; label: string }[]
  onChange: (value: string) => void
  testId: string
}) {
  return (
    <section className="space-y-1.5">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </h3>
      <ToggleGroup
        type="single"
        size="sm"
        value={value}
        aria-label={label}
        className="flex flex-wrap justify-start gap-1"
        // Radix clears the value when the active item is clicked again, which
        // here reads as "stop filtering by this" and is a useful gesture.
        onValueChange={(next) => onChange(next || "all")}
      >
        <ToggleGroupItem value="all" data-testid={`${testId}-all`}>
          {allLabel}
        </ToggleGroupItem>
        {options.map((option) => (
          <ToggleGroupItem
            key={option.value}
            value={option.value}
            data-testid={`${testId}-${option.value}`}
          >
            {option.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </section>
  )
}
