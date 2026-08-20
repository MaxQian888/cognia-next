"use client"

// Right-side filter sheet for the "My Servers" tab — wires the previously
// dormant `transportFilter` / `statusFilter` store state to a UI. Mirrors the
// established per-domain pattern (`components/skills/skill-filter-sheet.tsx`):
// a Sheet with one Select per filter axis and a footer reset. There is no
// shared FilterSheet primitive, so each surface owns its own thin sheet.

import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  useMcpPanelStore,
  type McpStatusFilter,
  type McpTransportFilter,
  type McpTrustFilter,
} from "@/stores/mcp/mcp-panel-store"
import { MCP_TRANSPORT_VALUES } from "./mcp-server-utils"

const STATUS_OPTIONS: Exclude<McpStatusFilter, "all">[] = ["enabled", "disabled"]
const TRUST_OPTIONS: Exclude<McpTrustFilter, "all">[] = ["pending", "legacy", "trusted", "blocked"]

export function McpFilterSheet() {
  const t = useTranslations("mcp")
  const open = useMcpPanelStore((s) => s.filterSheetOpen)
  const setOpen = useMcpPanelStore((s) => s.setFilterSheetOpen)
  const transportFilter = useMcpPanelStore((s) => s.transportFilter)
  const statusFilter = useMcpPanelStore((s) => s.statusFilter)
  const setTransportFilter = useMcpPanelStore((s) => s.setTransportFilter)
  const setStatusFilter = useMcpPanelStore((s) => s.setStatusFilter)
  const trustFilter = useMcpPanelStore((s) => s.trustFilter)
  const setTrustFilter = useMcpPanelStore((s) => s.setTrustFilter)
  const resetFilters = useMcpPanelStore((s) => s.resetFilters)

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent side="right" className="w-80 p-0 sm:w-96">
        <SheetHeader className="border-b px-5 py-4">
          <SheetTitle>{t("view.filters")}</SheetTitle>
          <SheetDescription>{t("filter.description")}</SheetDescription>
        </SheetHeader>
        <div className="space-y-4 px-5 py-4">
          <div className="space-y-1.5">
            <Label className="text-xs">{t("filter.transport")}</Label>
            <Select
              value={transportFilter}
              onValueChange={(v) => setTransportFilter(v as McpTransportFilter)}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all" className="text-xs">
                  {t("filter.all")}
                </SelectItem>
                {MCP_TRANSPORT_VALUES.map((tr) => (
                  <SelectItem key={tr} value={tr} className="text-xs">
                    {tr}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">{t("filter.status")}</Label>
            <Select
              value={statusFilter}
              onValueChange={(v) => setStatusFilter(v as McpStatusFilter)}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all" className="text-xs">
                  {t("filter.all")}
                </SelectItem>
                {STATUS_OPTIONS.map((s) => (
                  <SelectItem key={s} value={s} className="text-xs">
                    {t(`filter.${s}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">{t("filter.trust")}</Label>
            <Select value={trustFilter} onValueChange={(v) => setTrustFilter(v as McpTrustFilter)}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all" className="text-xs">
                  {t("filter.all")}
                </SelectItem>
                {TRUST_OPTIONS.map((state) => (
                  <SelectItem key={state} value={state} className="text-xs">
                    {t(`card.trust.${state}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <SheetFooter className="border-t px-5 py-3">
          <Button variant="ghost" size="sm" onClick={resetFilters}>
            {t("list.clearFilters")}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
