"use client"

import { useMemo, useState, useEffect } from "react"
import { useTranslations } from "next-intl"
import { SearchIcon, XIcon } from "lucide-react"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar"
import {
  SETTINGS_GROUP_ORDER,
  SETTINGS_NAV,
  isSearchMatch,
  type NavItem,
  type SettingsGroup,
  type SettingsSectionId,
} from "./settings-nav-config"
import { isTauri } from "@/lib/tauri"

interface Props {
  activeSection: SettingsSectionId
  onSelect: (section: SettingsSectionId) => void
  searchQuery: string
  onSearchChange: (query: string) => void
}

export function SettingsSidebar({ activeSection, onSelect, searchQuery, onSearchChange }: Props) {
  const t = useTranslations()
  const { state, setOpenMobile } = useSidebar()
  const isCollapsed = state === "collapsed"
  const [desktopAvailable, setDesktopAvailable] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setDesktopAvailable(isTauri()), 0)
    return () => clearTimeout(timer)
  }, [])

  const navItems = useMemo(
    () => SETTINGS_NAV.filter((item) => !item.desktopOnly || desktopAvailable),
    [desktopAvailable]
  )

  // Translator that can take a fully-qualified key. next-intl's `useTranslations`
  // requires a namespace, but our keys span `settings.tabs` and
  // `settings.descriptions`; we wrap to a key-from-root signature.
  const tRoot = useMemo(() => (key: string) => t(key as never), [t])

  const filtered = useMemo(
    () => navItems.filter((item) => isSearchMatch(item, searchQuery, tRoot)),
    [navItems, searchQuery, tRoot]
  )

  const grouped = useMemo(() => {
    const buckets: Record<SettingsGroup, NavItem[]> = {
      ai: [],
      extensions: [],
      interface: [],
      data: [],
      observability: [],
      system: [],
    }
    for (const item of filtered) buckets[item.group].push(item)
    return buckets
  }, [filtered])

  const groupLabels: Record<SettingsGroup, string> = {
    ai: t("settings.groupAi"),
    extensions: t("settings.groupExtensions"),
    interface: t("settings.groupInterface"),
    data: t("settings.groupData"),
    observability: t("settings.groupObservability"),
    system: t("settings.groupSystem"),
  }

  return (
    <Sidebar collapsible="icon" className="border-r h-full">
      <SidebarHeader className="h-14 border-b border-sidebar-border/50 p-3 flex items-center group-data-[collapsible=icon]:h-12 group-data-[collapsible=icon]:p-2 group-data-[collapsible=icon]:border-none">
        {!isCollapsed && (
          <InputGroup className="h-9">
            <InputGroupAddon align="inline-start">
              <SearchIcon className="h-4 w-4" />
            </InputGroupAddon>
            <InputGroupInput
              placeholder={t("settings.searchPlaceholder")}
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              className="text-sm"
              autoComplete="off"
            />
            {searchQuery && (
              <InputGroupAddon align="inline-end">
                <InputGroupButton onClick={() => onSearchChange("")} size="icon-xs">
                  <XIcon className="h-3.5 w-3.5" />
                </InputGroupButton>
              </InputGroupAddon>
            )}
          </InputGroup>
        )}
      </SidebarHeader>
      <SidebarContent className="p-2">
        {filtered.length > 0 ? (
          SETTINGS_GROUP_ORDER.map((group) => {
            const items = grouped[group]
            if (items.length === 0) return null
            return (
              <SidebarGroup key={group} className="py-1">
                <SidebarGroupLabel className="px-2 text-[10px] font-semibold text-muted-foreground/70 uppercase tracking-wider">
                  {groupLabels[group]}
                </SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {items.map((item) => {
                      const Icon = item.icon
                      return (
                        <SidebarMenuItem key={item.id}>
                          <SidebarMenuButton
                            isActive={activeSection === item.id}
                            onClick={() => {
                              onSelect(item.id)
                              setOpenMobile(false)
                            }}
                            tooltip={t(`settings.descriptions.${item.descriptionKey}` as never)}
                            className="px-2.5 py-2 h-auto"
                          >
                            <Icon className="h-4 w-4" />
                            <div className="flex flex-col gap-0.5 text-left leading-none flex-1 min-w-0">
                              <span className="font-medium truncate">
                                {t(`settings.tabs.${item.labelKey}` as never)}
                              </span>
                            </div>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      )
                    })}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            )
          })
        ) : (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            {t("settings.noSettingsFound")}
          </div>
        )}
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  )
}
