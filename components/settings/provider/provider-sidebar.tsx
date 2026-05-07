"use client"

import React from "react"
import { useTranslations } from "next-intl"
import { Search, BarChart3 } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ProviderSidebarItem } from "./provider-sidebar-item"
import type { ProviderConnectionStatus } from "./provider-sidebar-item"

interface ProviderSidebarProps {
  providers: Array<{
    id: string
    name: string
    icon?: string | React.ReactNode
    subtitle: string
    status: ProviderConnectionStatus
    modelCount?: number
  }>
  selectedId: string | null
  onSelect: (id: string) => void
  onCompareClick: () => void
  categoryFilter: string
  onCategoryChange: (category: string) => void
  searchQuery: string
  onSearchChange: (query: string) => void
  addButton?: React.ReactNode
}

export function ProviderSidebar({
  providers,
  selectedId,
  onSelect,
  onCompareClick,
  categoryFilter,
  onCategoryChange,
  searchQuery,
  onSearchChange,
  addButton,
}: ProviderSidebarProps) {
  const t = useTranslations("providers")

  const total = providers.length
  const active = providers.filter((p) => p.status === "connected").length

  return (
    <div className="flex h-full w-full min-w-0 flex-col overflow-hidden">
      {/* Top: search + add button */}
      <div className="flex min-w-0 gap-2 border-b p-3">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-8"
            placeholder={t("sidebar.searchPlaceholder")}
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
          />
        </div>
        {addButton}
      </div>

      {/* Category filters */}
      <div className="min-w-0 border-b px-3 py-2">
        <Tabs value={categoryFilter} onValueChange={onCategoryChange} className="min-w-0">
          <TabsList className="h-8 w-full">
            <TabsTrigger value="all" className="min-w-0">
              All
            </TabsTrigger>
            <TabsTrigger value="ai" className="min-w-0">
              AI
            </TabsTrigger>
            <TabsTrigger value="local" className="min-w-0">
              Local
            </TabsTrigger>
            <TabsTrigger value="voice" className="min-w-0">
              Voice
            </TabsTrigger>
            <TabsTrigger value="vision" className="min-w-0">
              Vision
            </TabsTrigger>
            <TabsTrigger value="custom" className="min-w-0">
              Custom
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {/* Provider list (scrollable) */}
      <div className="flex-1 overflow-x-hidden overflow-y-auto p-1">
        {providers.map((p) => (
          <ProviderSidebarItem
            key={p.id}
            providerId={p.id}
            name={p.name}
            icon={p.icon}
            subtitle={p.subtitle}
            status={p.status}
            isSelected={p.id === selectedId}
            onClick={onSelect}
            modelCount={p.modelCount}
          />
        ))}
      </div>

      {/* Model Compare button */}
      <div className="min-w-0 border-t px-3 py-2">
        <Button variant="ghost" size="sm" onClick={onCompareClick} className="w-full justify-start">
          <BarChart3 className="mr-2 h-4 w-4" />
          {t("sidebar.modelCompare")}
        </Button>
      </div>

      {/* Stats bar */}
      <div className="min-w-0 border-t px-3 py-2 text-xs text-muted-foreground">
        {t("sidebar.stats", { total, active })}
      </div>
    </div>
  )
}
