"use client"

import { useMemo, useEffect, useRef } from "react"
import { useTranslations } from "next-intl"
import { ChevronRightIcon, SearchIcon, XIcon } from "lucide-react"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
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
import { useSettingsSectionReachability } from "@/hooks/settings/use-settings-section-reachability"
import { useSettingsSidebarCollapse } from "@/hooks/settings/use-settings-sidebar-collapse"

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
  const { isGroupCollapsed, setGroupCollapsed, expandGroup } = useSettingsSidebarCollapse()
  const { navItems } = useSettingsSectionReachability()

  // While searching, collapse state is ignored: every group with a hit is
  // forced open (the persisted state is left untouched).
  const searching = searchQuery.trim().length > 0

  // Deep links (`?section=`) and search-result clicks can land on a section
  // inside a collapsed group — expand (and persist) that group so the active
  // item stays visible. The ref keys on the section so a manual collapse of
  // the active group right after isn't immediately undone.
  const activeGroup = useMemo(
    () => SETTINGS_NAV.find((item) => item.id === activeSection)?.group,
    [activeSection]
  )
  const lastAutoExpandedRef = useRef<SettingsSectionId | null>(null)
  useEffect(() => {
    if (lastAutoExpandedRef.current === activeSection) return
    lastAutoExpandedRef.current = activeSection
    if (activeGroup && isGroupCollapsed(activeGroup)) void expandGroup(activeGroup)
  }, [activeSection, activeGroup, isGroupCollapsed, expandGroup])

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
      <SidebarHeader className="h-[var(--chrome-h-tall)] border-b border-sidebar-border/50 p-3 flex items-center group-data-[collapsible=icon]:h-[var(--chrome-h)] group-data-[collapsible=icon]:p-2 group-data-[collapsible=icon]:border-none">
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
      {/* Icon mode drops the horizontal padding: the rail is only
          `--sidebar-width-icon` (3rem) wide and the menu buttons are forced to
          `size-8` (2rem), so `SidebarContent` + `SidebarGroup` padding would
          leave 1rem and clip every icon in half. */}
      <SidebarContent className="p-2 group-data-[collapsible=icon]:px-0">
        {filtered.length > 0 ? (
          SETTINGS_GROUP_ORDER.map((group) => {
            const items = grouped[group]
            if (items.length === 0) return null
            // Icon-collapsed sidebar hides group labels entirely; keep the
            // menu items visible regardless of the persisted collapse state.
            const open = searching || isCollapsed || !isGroupCollapsed(group)
            return (
              <Collapsible
                key={group}
                open={open}
                onOpenChange={(next) => {
                  if (searching || isCollapsed) return
                  void setGroupCollapsed(group, !next)
                }}
                className="group/collapsible"
              >
                <SidebarGroup className="py-1 group-data-[collapsible=icon]:px-0">
                  <SidebarGroupLabel
                    asChild
                    // In icon mode the base label is only `opacity-0` + `-mt-8`,
                    // so it still overlays (and swallows clicks on) the first
                    // menu item — make it inert there.
                    className="px-2 text-[10px] font-semibold text-muted-foreground/70 uppercase tracking-wider group-data-[collapsible=icon]:pointer-events-none"
                  >
                    <CollapsibleTrigger
                      disabled={searching}
                      className="w-full cursor-pointer hover:text-foreground/80 disabled:cursor-default"
                    >
                      {groupLabels[group]}
                      {!searching && (
                        <ChevronRightIcon className="ml-auto h-3 w-3 shrink-0 transition-transform duration-200 ease-out group-data-[state=open]/collapsible:rotate-90 motion-reduce:transition-none" />
                      )}
                    </CollapsibleTrigger>
                  </SidebarGroupLabel>
                  <CollapsibleContent className="overflow-hidden data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up motion-reduce:animate-none">
                    <SidebarGroupContent>
                      <SidebarMenu className="group-data-[collapsible=icon]:items-center">
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
                                className="px-2.5 py-2 h-auto group-data-[collapsible=icon]:justify-center"
                              >
                                <Icon className="h-4 w-4" />
                                {/* Not a `span:last-child`, so the base
                                    icon-mode rules don't hide it — without this
                                    the label keeps consuming the 2rem button
                                    and pushes the icon out of view. */}
                                <div className="flex flex-col gap-0.5 text-left leading-none flex-1 min-w-0 group-data-[collapsible=icon]:hidden">
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
                  </CollapsibleContent>
                </SidebarGroup>
              </Collapsible>
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
