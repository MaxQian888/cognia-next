"use client"

import {
  ArrowDownUpIcon,
  BookmarkIcon,
  BookmarkPlusIcon,
  BotIcon,
  CalendarClockIcon,
  CheckIcon,
  CircleDotIcon,
  CpuIcon,
  EyeOffIcon,
  FilterIcon,
  FolderTreeIcon,
  RotateCcwIcon,
  SaveIcon,
  SettingsIcon,
  TelescopeIcon,
  Trash2Icon,
  XIcon,
  type LucideIcon,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { useCallback, useMemo, useState, type ComponentProps, type ReactNode } from "react"

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { useIsMobile } from "@/hooks/ui/use-mobile"
import type { ConversationFilterOption } from "@/lib/chat/conversation-filter-options"
import {
  CONVERSATION_ACTIVITY_FILTER_OPTIONS,
  CONVERSATION_FILTER_LIST_KEYS,
  CONVERSATION_FILTER_TOGGLES,
  CONVERSATION_FILTER_UNASSIGNED,
  CONVERSATION_KIND_FILTER_OPTIONS,
  CONVERSATION_SORT_BY_OPTIONS,
  DEFAULT_CONVERSATION_SORT_BY,
  type ConversationFilterListKey,
} from "@/lib/chat/conversation-filters"
import {
  CONTENT_SEARCH_MIN_QUERY,
  CONVERSATION_SEARCH_WORKSPACE_OPTIONS,
  countWidenedSearchAxes,
} from "@/lib/chat/conversation-search-scope"
import {
  BUILT_IN_CONVERSATION_VIEWS,
  CONVERSATION_VIEW_DIMENSIONS,
  CONVERSATION_VIEW_NAME_MAX,
  type ConversationViewDimension,
  type ResolvedConversationView,
} from "@/lib/chat/conversation-views"
import { cn } from "@/lib/utils"
import type { ConversationFilterController } from "@/hooks/chat/use-conversation-filter-controller"

/**
 * Sort + filter controls for the conversation list, shared by the desktop
 * sidebar (`components/desktop/channel-list.tsx`) and the mobile channel list
 * (`components/mobile/shell/mobile-channel-list.tsx`).
 *
 * Shared rather than duplicated per surface because the *vocabulary* is the
 * product decision here: two copies would drift into two different names for
 * "unread only" in two places, in two languages. Both surfaces feed the same
 * view model (`useConversationFilterController`) in; each still owns its own
 * placement and trigger size.
 *
 * Two shells over one descriptor:
 * - **Desktop** — a dropdown that opens *beside* the trigger (default `side:
 *   "right"`, i.e. over the chat pane, never over the list it filters), with
 *   one hover-expanding submenu per facet. Ticking an option keeps the menu
 *   open — it is a filter builder, not a command list.
 * - **Mobile** (`useIsMobile`) — a bottom drawer with one accordion section
 *   per facet and 44px rows; hover has no meaning on touch.
 *
 * Deliberately separate from each surface's display-options menu: display
 * options change how a row *looks*, these change which rows exist and in what
 * order — the difference between "I can't read this" and "where did my
 * conversation go".
 */

/** The slice of the controller the controls read. */
export type ConversationFilterViewModel = Pick<
  ConversationFilterController,
  | "filters"
  | "activeFilters"
  | "sortBy"
  | "groupBy"
  | "search"
  | "options"
  | "views"
  | "activeView"
  | "activeViewDrift"
  | "hiddenViewIds"
  | "suggestedViewDimensions"
  | "actions"
>

/**
 * A view's display name.
 *
 * Built-ins carry a translation key rather than text, so the label follows the
 * app's locale instead of whichever one the view happened to be created in.
 * Custom views carry the user's own words and are shown verbatim.
 */
function useViewLabel() {
  const t = useTranslations("conversationFilters")
  return useCallback(
    (view: Pick<ResolvedConversationView, "name" | "builtIn">) =>
      view.builtIn ? t(view.name as never) : view.name,
    [t]
  )
}

export interface ConversationFilterMenuProps {
  model: ConversationFilterViewModel
  /** Where the desktop menu opens relative to the trigger. Defaults to `"right"`. */
  side?: "right" | "left" | "top" | "bottom"
  /** Extra classes for the trigger button (each surface sizes its own chrome). */
  triggerClassName?: string
  /** Distinguishes the two surfaces' triggers in tests. */
  testId?: string
}

// ---------------------------------------------------------------------------
// Descriptor: what the menu offers, independent of which shell draws it
// ---------------------------------------------------------------------------

interface FacetItem {
  value: string
  label: string
  checked: boolean
  count?: number
  onSelect: () => void
}

interface FacetGroup {
  key: string
  /** Sub-heading when a section holds more than one group. */
  label?: string
  kind: "radio" | "check"
  items: FacetItem[]
}

interface FacetSection {
  key: string
  icon: LucideIcon
  label: string
  /** How many decisions inside this section narrow the list — the badge on the row. */
  activeCount: number
  /** Short readout of the current choice for the row (sort mode, "3 selected"). */
  summary?: string
  groups: FacetGroup[]
}

const LIST_FACET_META: Record<
  ConversationFilterListKey,
  { section: "location" | "agent" | "model"; ns: string; unassigned: boolean }
> = {
  workspaceIds: { section: "location", ns: "workspace", unassigned: true },
  folderIds: { section: "location", ns: "folder", unassigned: true },
  agentIds: { section: "agent", ns: "agent", unassigned: true },
  teamIds: { section: "agent", ns: "team", unassigned: false },
  providers: { section: "model", ns: "provider", unassigned: false },
  models: { section: "model", ns: "model", unassigned: false },
}

const SECTION_ICON: Record<
  "sort" | "status" | "location" | "agent" | "model" | "activity",
  LucideIcon
> = {
  sort: ArrowDownUpIcon,
  status: CircleDotIcon,
  location: FolderTreeIcon,
  agent: BotIcon,
  model: CpuIcon,
  activity: CalendarClockIcon,
}

function useFacetSections(model: ConversationFilterViewModel): FacetSection[] {
  const t = useTranslations("conversationFilters")
  const { filters, sortBy, options, actions } = model
  return useMemo<FacetSection[]>(() => {
    const sections: FacetSection[] = []

    sections.push({
      key: "sort",
      icon: SECTION_ICON.sort,
      label: t("sort.label"),
      activeCount: sortBy === DEFAULT_CONVERSATION_SORT_BY ? 0 : 1,
      summary: t(`sort.options.${sortBy}`),
      groups: [
        {
          key: "sort",
          kind: "radio",
          items: CONVERSATION_SORT_BY_OPTIONS.map((option) => ({
            value: option,
            label: t(`sort.options.${option}`),
            checked: sortBy === option,
            onSelect: () => actions.setSortBy(option),
          })),
        },
      ],
    })

    const toggleCount = CONVERSATION_FILTER_TOGGLES.filter((key) => filters[key]).length
    sections.push({
      key: "status",
      icon: SECTION_ICON.status,
      label: t("filters.label"),
      activeCount: toggleCount + (filters.kind === "all" ? 0 : 1),
      summary: filters.kind === "all" ? undefined : t(`kind.options.${filters.kind}`),
      groups: [
        {
          key: "toggles",
          kind: "check",
          items: CONVERSATION_FILTER_TOGGLES.map((key) => ({
            value: key,
            label: t(`filters.options.${key}`),
            checked: filters[key],
            onSelect: () => actions.toggle(key, !filters[key]),
          })),
        },
        {
          key: "kind",
          label: t("kind.label"),
          kind: "radio",
          items: CONVERSATION_KIND_FILTER_OPTIONS.map((option) => ({
            value: option,
            label: t(`kind.options.${option}`),
            checked: filters.kind === option,
            onSelect: () => actions.setKind(option),
          })),
        },
      ],
    })

    // List facets, folded into three sections so the top level stays short
    // enough to scan: where (workspace / folder), who (agent / team), what
    // (provider / model). A section only exists when at least one of its
    // facets has something to offer.
    const listSections = new Map<"location" | "agent" | "model", FacetSection>()
    for (const key of CONVERSATION_FILTER_LIST_KEYS) {
      const candidates = options[key]
      if (candidates.length === 0) continue
      const meta = LIST_FACET_META[key]
      const selected = filters[key]
      let section = listSections.get(meta.section)
      if (!section) {
        section = {
          key: meta.section,
          icon: SECTION_ICON[meta.section],
          label: t(`sections.${meta.section}`),
          activeCount: 0,
          groups: [],
        }
        listSections.set(meta.section, section)
        sections.push(section)
      }
      if (selected.length > 0) section.activeCount += 1
      const anyItem: FacetItem = {
        value: "",
        label: t(`${meta.ns}.any`),
        checked: selected.length === 0,
        onSelect: () => actions.setList(key, []),
      }
      const items: FacetItem[] = candidates.map((option: ConversationFilterOption) => ({
        value: option.value,
        label:
          option.value === CONVERSATION_FILTER_UNASSIGNED
            ? t(`${meta.ns}.unassigned`)
            : (option.label ?? option.value),
        checked: selected.includes(option.value),
        count: option.count,
        onSelect: () => actions.toggleValue(key, option.value, !selected.includes(option.value)),
      }))
      section.groups.push({
        key,
        label: t(`${meta.ns}.label`),
        kind: "check",
        items: [anyItem, ...items],
      })
    }
    for (const section of listSections.values()) {
      const picked = section.groups.reduce(
        (n, group) => n + group.items.filter((item) => item.value && item.checked).length,
        0
      )
      section.summary = picked > 0 ? t("selectedSummary", { count: picked }) : undefined
    }

    sections.push({
      key: "activity",
      icon: SECTION_ICON.activity,
      label: t("activity.label"),
      activeCount: filters.activity === "any" ? 0 : 1,
      summary: filters.activity === "any" ? undefined : t(`activity.options.${filters.activity}`),
      groups: [
        {
          key: "activity",
          kind: "radio",
          items: CONVERSATION_ACTIVITY_FILTER_OPTIONS.map((option) => ({
            value: option,
            label: t(`activity.options.${option}`),
            checked: filters.activity === option,
            onSelect: () => actions.setActivity(option),
          })),
        },
      ],
    })

    return sections
  }, [t, filters, sortBy, options, actions])
}

// ---------------------------------------------------------------------------
// Trigger
// ---------------------------------------------------------------------------

function FilterTrigger({
  activeFilters,
  className,
  testId,
  ...props
}: {
  activeFilters: number
  className?: string
  testId: string
} & ComponentProps<typeof Button>) {
  const t = useTranslations("conversationFilters")
  const label = activeFilters > 0 ? t("labelActive", { count: activeFilters }) : t("label")
  return (
    <Button
      size="icon"
      variant="ghost"
      className={cn("relative shrink-0", activeFilters > 0 && "text-primary", className)}
      aria-label={label}
      title={label}
      data-testid={testId}
      data-active-filters={activeFilters || undefined}
      {...props}
    >
      <FilterIcon className="size-4" />
      {activeFilters > 0 ? (
        <span
          aria-hidden
          className="absolute top-1 right-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-0.5 text-[9px] leading-none font-semibold text-primary-foreground tabular-nums"
          data-testid={`${testId}-dot`}
        >
          {activeFilters}
        </span>
      ) : null}
    </Button>
  )
}

/** Small count pill used on section rows (desktop + mobile). */
function CountPill({ count, className }: { count: number; className?: string }) {
  if (count <= 0) return null
  return (
    <span
      className={cn(
        "inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-primary/15 px-1 text-[10px] leading-none font-medium text-primary tabular-nums",
        className
      )}
      data-testid="conversation-filter-section-count"
    >
      {count}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Menu (responsive shell + view dialogs)
// ---------------------------------------------------------------------------

export function ConversationFilterMenu({
  model,
  side = "right",
  triggerClassName,
  testId = "conversation-filter-trigger",
}: ConversationFilterMenuProps) {
  const isMobile = useIsMobile()
  const sections = useFacetSections(model)
  const [saveOpen, setSaveOpen] = useState(false)
  const [manageOpen, setManageOpen] = useState(false)
  const openSave = useCallback(() => setSaveOpen(true), [])
  const openManage = useCallback(() => setManageOpen(true), [])

  return (
    <>
      {isMobile ? (
        <FilterDrawer
          model={model}
          sections={sections}
          triggerClassName={triggerClassName}
          testId={testId}
          onSaveView={openSave}
          onManageViews={openManage}
        />
      ) : (
        <FilterDropdown
          model={model}
          sections={sections}
          side={side}
          triggerClassName={triggerClassName}
          testId={testId}
          onSaveView={openSave}
          onManageViews={openManage}
        />
      )}
      <SaveViewDialog
        open={saveOpen}
        onOpenChange={setSaveOpen}
        suggested={model.suggestedViewDimensions}
        onSave={model.actions.saveView}
      />
      <ManageViewsDialog
        open={manageOpen}
        onOpenChange={setManageOpen}
        views={model.views}
        hiddenViewIds={model.hiddenViewIds}
        onRename={model.actions.renameView}
        onRemove={model.actions.removeView}
        onRestore={model.actions.restoreView}
      />
    </>
  )
}

interface ShellProps {
  model: ConversationFilterViewModel
  sections: FacetSection[]
  triggerClassName?: string
  testId: string
  onSaveView: () => void
  onManageViews: () => void
}

/** Keep the menu open on select — the user is composing a filter, not firing a command. */
const keepOpen = (event: Event) => event.preventDefault()

function FilterDropdown({
  model,
  sections,
  side,
  triggerClassName,
  testId,
  onSaveView,
  onManageViews,
}: ShellProps & { side: NonNullable<ConversationFilterMenuProps["side"]> }) {
  const t = useTranslations("conversationFilters")
  const labelOf = useViewLabel()
  const { activeFilters, views, activeView, activeViewDrift, suggestedViewDimensions, actions } =
    model
  const modified = activeViewDrift.length > 0
  // Saving is only meaningful when something is worth pinning; sitting inside
  // an unmodified view means it is already saved.
  const canSave = suggestedViewDimensions.length > 0 && !(activeView && !modified)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <FilterTrigger activeFilters={activeFilters} className={triggerClassName} testId={testId} />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side={side}
        align="start"
        sideOffset={6}
        collisionPadding={8}
        className="w-60"
        data-testid={`${testId}-menu`}
      >
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="gap-2">
            <BookmarkIcon className="size-4 text-muted-foreground" aria-hidden />
            <span className="flex-1 truncate">{t("views.label")}</span>
            {activeView ? (
              <span className="max-w-24 truncate text-xs text-muted-foreground">
                {modified
                  ? t("views.modifiedChip", { name: labelOf(activeView) })
                  : labelOf(activeView)}
              </span>
            ) : null}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-60" data-testid={`${testId}-views`}>
            {views.length === 0 ? (
              <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                {t("views.empty")}
              </DropdownMenuLabel>
            ) : (
              views.map((view) => (
                <DropdownMenuCheckboxItem
                  key={view.id}
                  checked={activeView?.id === view.id}
                  // Re-picking the view you are already in is how you get back
                  // to it after nudging something — never a way to leave it.
                  onCheckedChange={() => actions.applyView(view.id)}
                  data-testid={`${testId}-view-${view.id}`}
                >
                  <span className="flex-1 truncate">{labelOf(view)}</span>
                  {view.builtIn ? (
                    <span className="ml-1 shrink-0 text-[10px] text-muted-foreground">
                      {t("views.builtInBadge")}
                    </span>
                  ) : null}
                </DropdownMenuCheckboxItem>
              ))
            )}
            {activeView ? (
              <>
                <DropdownMenuSeparator />
                {modified ? (
                  <>
                    <DropdownMenuItem
                      onSelect={actions.revertView}
                      data-testid={`${testId}-view-revert`}
                    >
                      <RotateCcwIcon className="size-4" />
                      {t("views.revert")}
                    </DropdownMenuItem>
                    {activeView.builtIn ? null : (
                      <DropdownMenuItem
                        onSelect={() => actions.updateView(activeView.id)}
                        data-testid={`${testId}-view-update`}
                      >
                        <SaveIcon className="size-4" />
                        {t("views.update")}
                      </DropdownMenuItem>
                    )}
                  </>
                ) : null}
                <DropdownMenuItem onSelect={actions.clearView}>
                  <XIcon className="size-4" />
                  {t("views.clear")}
                </DropdownMenuItem>
              </>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={!canSave}
              onSelect={onSaveView}
              data-testid={`${testId}-view-save`}
            >
              <BookmarkPlusIcon className="size-4" />
              {t("views.save")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onManageViews}>
              <SettingsIcon className="size-4" />
              {t("views.manage")}
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        {sections.map((section) => (
          <DropdownMenuSub key={section.key}>
            <DropdownMenuSubTrigger
              className="gap-2"
              data-testid={`${testId}-section-${section.key}`}
            >
              <section.icon className="size-4 text-muted-foreground" aria-hidden />
              <span className="flex-1 truncate">{section.label}</span>
              {section.summary ? (
                <span className="max-w-24 truncate text-xs text-muted-foreground">
                  {section.summary}
                </span>
              ) : null}
              <CountPill count={section.activeCount} />
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-[min(70vh,480px)] w-56 overflow-y-auto">
              {section.groups.map((group, index) => (
                <div key={group.key}>
                  {index > 0 ? <DropdownMenuSeparator /> : null}
                  {group.label ? (
                    <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                      {group.label}
                    </DropdownMenuLabel>
                  ) : null}
                  {group.kind === "radio" ? (
                    <DropdownMenuRadioGroup
                      value={group.items.find((item) => item.checked)?.value}
                      onValueChange={(value) =>
                        group.items.find((item) => item.value === value)?.onSelect()
                      }
                    >
                      {group.items.map((item) => (
                        <DropdownMenuRadioItem
                          key={item.value}
                          value={item.value}
                          onSelect={keepOpen}
                        >
                          {item.label}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  ) : (
                    group.items.map((item) => (
                      <DropdownMenuCheckboxItem
                        key={item.value || "__any__"}
                        checked={item.checked}
                        onCheckedChange={item.onSelect}
                        onSelect={keepOpen}
                        className={cn(!item.value && "text-muted-foreground")}
                      >
                        <span className="flex-1 truncate">{item.label}</span>
                        {item.count != null ? (
                          <span className="ml-2 shrink-0 text-xs text-muted-foreground tabular-nums">
                            {item.count}
                          </span>
                        ) : null}
                      </DropdownMenuCheckboxItem>
                    ))
                  )}
                </div>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ))}
        {activeFilters > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={actions.reset}>
              <XIcon className="size-4" />
              {t("clearAll")}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function FilterDrawer({
  model,
  sections,
  triggerClassName,
  testId,
  onSaveView,
  onManageViews,
}: ShellProps) {
  const t = useTranslations("conversationFilters")
  const labelOf = useViewLabel()
  const { activeFilters, views, activeView, activeViewDrift, suggestedViewDimensions, actions } =
    model
  const modified = activeViewDrift.length > 0
  const [open, setOpen] = useState(false)
  const canSave = suggestedViewDimensions.length > 0 && !(activeView && !modified)
  return (
    <>
      <FilterTrigger
        activeFilters={activeFilters}
        className={triggerClassName}
        testId={testId}
        onClick={() => setOpen(true)}
      />
      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerContent
          className="max-h-[85vh] pb-[env(safe-area-inset-bottom)]"
          data-testid={`${testId}-drawer`}
        >
          <DrawerHeader className="pb-2 text-left">
            <DrawerTitle className="flex items-center gap-2">
              <FilterIcon className="size-4 text-muted-foreground" aria-hidden />
              {t("drawer.title")}
            </DrawerTitle>
            <DrawerDescription>
              {activeFilters > 0 ? t("labelActive", { count: activeFilters }) : t("drawer.hint")}
            </DrawerDescription>
          </DrawerHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-4">
            <div className="flex flex-col gap-2 border-b py-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <BookmarkIcon className="size-4 text-muted-foreground" aria-hidden />
                <span className="flex-1">{t("views.label")}</span>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={!canSave}
                  onClick={() => {
                    setOpen(false)
                    onSaveView()
                  }}
                >
                  <BookmarkPlusIcon className="size-3.5" />
                  {t("views.saveShort")}
                </Button>
                {views.length > 0 ? (
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={t("views.manage")}
                    onClick={() => {
                      setOpen(false)
                      onManageViews()
                    }}
                  >
                    <SettingsIcon className="size-3.5" />
                  </Button>
                ) : null}
              </div>
              {views.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("views.empty")}</p>
              ) : (
                <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
                  {views.map((view) => {
                    const active = activeView?.id === view.id
                    return (
                      <button
                        key={view.id}
                        type="button"
                        onClick={() => actions.applyView(view.id)}
                        aria-pressed={active}
                        data-testid={`${testId}-view-${view.id}`}
                        className={cn(
                          "inline-flex h-8 shrink-0 items-center gap-1 rounded-full border px-3 text-xs transition-colors",
                          active
                            ? "border-primary/40 bg-primary/15 text-primary"
                            : "border-border bg-muted/40 text-foreground"
                        )}
                      >
                        {active && !modified ? <CheckIcon className="size-3" aria-hidden /> : null}
                        <span className="max-w-40 truncate">{labelOf(view)}</span>
                      </button>
                    )
                  })}
                </div>
              )}
              {activeView && modified ? (
                // Same two exits the desktop menu offers, at touch size.
                <div className="flex gap-2">
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={actions.revertView}
                    data-testid={`${testId}-view-revert`}
                  >
                    <RotateCcwIcon className="size-3.5" />
                    {t("views.revert")}
                  </Button>
                  {activeView.builtIn ? null : (
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => actions.updateView(activeView.id)}
                      data-testid={`${testId}-view-update`}
                    >
                      <SaveIcon className="size-3.5" />
                      {t("views.update")}
                    </Button>
                  )}
                </div>
              ) : null}
            </div>
            <Accordion type="multiple" defaultValue={["sort", "status"]}>
              {sections.map((section) => (
                <AccordionItem key={section.key} value={section.key}>
                  <AccordionTrigger
                    className="items-center py-3 hover:no-underline"
                    data-testid={`${testId}-section-${section.key}`}
                  >
                    <span className="flex min-w-0 flex-1 items-center gap-2">
                      <section.icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="truncate">{section.label}</span>
                      {section.summary ? (
                        <span className="ml-1 truncate text-xs font-normal text-muted-foreground">
                          {section.summary}
                        </span>
                      ) : null}
                      <CountPill count={section.activeCount} className="ml-auto" />
                    </span>
                  </AccordionTrigger>
                  <AccordionContent className="pb-2">
                    {section.groups.map((group, index) => (
                      <div key={group.key} className={cn(index > 0 && "mt-2 border-t pt-2")}>
                        {group.label ? (
                          <p className="px-1 py-1 text-xs text-muted-foreground">{group.label}</p>
                        ) : null}
                        {group.kind === "radio" ? (
                          <RadioGroup
                            value={group.items.find((item) => item.checked)?.value}
                            onValueChange={(value) =>
                              group.items.find((item) => item.value === value)?.onSelect()
                            }
                            className="gap-0"
                          >
                            {group.items.map((item) => (
                              <label
                                key={item.value}
                                className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-1 text-sm active:bg-accent/60"
                              >
                                <RadioGroupItem value={item.value} />
                                <span className="flex-1 truncate">{item.label}</span>
                              </label>
                            ))}
                          </RadioGroup>
                        ) : (
                          group.items.map((item) => (
                            <label
                              key={item.value || "__any__"}
                              className={cn(
                                "flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-1 text-sm active:bg-accent/60",
                                !item.value && "text-muted-foreground"
                              )}
                            >
                              <Checkbox checked={item.checked} onCheckedChange={item.onSelect} />
                              <span className="flex-1 truncate">{item.label}</span>
                              {item.count != null ? (
                                <span className="text-xs text-muted-foreground tabular-nums">
                                  {item.count}
                                </span>
                              ) : null}
                            </label>
                          ))
                        )}
                      </div>
                    ))}
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </div>
          <DrawerFooter className="flex-row gap-2 pt-3">
            {activeFilters > 0 ? (
              <Button variant="outline" className="flex-1" onClick={actions.reset}>
                <XIcon className="size-4" />
                {t("clearAll")}
              </Button>
            ) : null}
            <DrawerClose asChild>
              <Button className="flex-1">{t("drawer.done")}</Button>
            </DrawerClose>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>
    </>
  )
}

// ---------------------------------------------------------------------------
// Preset dialogs
// ---------------------------------------------------------------------------

function SaveViewDialog({
  open,
  onOpenChange,
  suggested,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Dimensions the current state has moved off its defaults — pre-ticked. */
  suggested: readonly ConversationViewDimension[]
  onSave: (name: string, dimensions: readonly ConversationViewDimension[]) => string | null
}) {
  const t = useTranslations("conversationFilters")
  const [name, setName] = useState("")
  const [rejected, setRejected] = useState(false)
  const [picked, setPicked] = useState<readonly ConversationViewDimension[]>(suggested)
  // Reset the draft each time the dialog opens — derived from `open` at the
  // change boundary rather than in an effect.
  const [seenOpen, setSeenOpen] = useState(open)
  if (seenOpen !== open) {
    setSeenOpen(open)
    setName("")
    setRejected(false)
    // Whatever the user has moved is presumably why they are saving; starting
    // from an empty set makes them re-state what is already on screen.
    setPicked(suggested)
  }
  const toggle = (dimension: ConversationViewDimension, on: boolean) =>
    setPicked((current) =>
      on ? [...current, dimension] : current.filter((entry) => entry !== dimension)
    )
  const submit = () => {
    const id = onSave(name, picked)
    if (id) onOpenChange(false)
    else setRejected(true)
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-[90vw] sm:max-w-sm"
        data-testid="conversation-view-save-dialog"
      >
        <DialogHeader>
          <DialogTitle>{t("views.saveTitle")}</DialogTitle>
          <DialogDescription>{t("views.saveDescription")}</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
          className="flex flex-col gap-3"
        >
          <Input
            autoFocus
            value={name}
            maxLength={CONVERSATION_VIEW_NAME_MAX}
            onChange={(event) => {
              setName(event.target.value)
              setRejected(false)
            }}
            placeholder={t("views.namePlaceholder")}
            aria-label={t("views.namePlaceholder")}
            aria-invalid={rejected || undefined}
          />
          {/* Which dimensions this view pins. Everything unticked keeps
              following whatever the user sets later — that is what makes a view
              an overlay rather than a photograph. */}
          <fieldset className="flex flex-col gap-1.5">
            <legend className="pb-1 text-xs text-muted-foreground">
              {t("views.dimensions.legend")}
            </legend>
            {CONVERSATION_VIEW_DIMENSIONS.map((dimension) => (
              <label
                key={dimension}
                className="flex items-center gap-2 text-sm"
                data-testid={`conversation-view-dimension-${dimension}`}
              >
                <Checkbox
                  checked={picked.includes(dimension)}
                  onCheckedChange={(checked) => {
                    toggle(dimension, checked === true)
                    setRejected(false)
                  }}
                />
                <span>{t(`views.dimensions.${dimension}`)}</span>
              </label>
            ))}
          </fieldset>
          {rejected ? (
            <p className="text-xs text-destructive" role="alert">
              {t("views.saveRejected")}
            </p>
          ) : null}
          <DialogFooter className="mt-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t("cancel")}
            </Button>
            <Button type="submit" disabled={!name.trim() || picked.length === 0}>
              {t("views.saveAction")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function ManageViewsDialog({
  open,
  onOpenChange,
  views,
  hiddenViewIds,
  onRename,
  onRemove,
  onRestore,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  views: ConversationFilterViewModel["views"]
  hiddenViewIds: readonly string[]
  onRename: (id: string, name: string) => void
  onRemove: (id: string) => void
  onRestore: (id: string) => void
}) {
  const t = useTranslations("conversationFilters")
  const labelOf = useViewLabel()
  const hidden = useMemo(
    () => BUILT_IN_CONVERSATION_VIEWS.filter((view) => hiddenViewIds.includes(view.id)),
    [hiddenViewIds]
  )
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-[90vw] sm:max-w-md"
        data-testid="conversation-view-manage-dialog"
      >
        <DialogHeader>
          <DialogTitle>{t("views.manageTitle")}</DialogTitle>
          <DialogDescription>{t("views.manageDescription")}</DialogDescription>
        </DialogHeader>
        <ul className="flex max-h-[60vh] flex-col gap-1 overflow-y-auto">
          {views.map((view) => (
            <ViewRow
              key={view.id}
              view={view}
              label={labelOf(view)}
              onRename={onRename}
              onRemove={onRemove}
            />
          ))}
        </ul>
        {hidden.length > 0 ? (
          // Built-ins are code, not data: they are hidden rather than deleted,
          // so there has to be somewhere to put them back from.
          <div className="flex flex-col gap-1 border-t pt-3">
            <p className="text-xs text-muted-foreground">{t("views.hidden")}</p>
            <div className="flex flex-wrap gap-1.5">
              {hidden.map((view) => (
                <Button
                  key={view.id}
                  size="xs"
                  variant="outline"
                  onClick={() => onRestore(view.id)}
                  aria-label={t("views.restore", { name: labelOf(view) })}
                  data-testid={`conversation-view-restore-${view.id}`}
                >
                  <RotateCcwIcon className="size-3.5" />
                  {labelOf(view)}
                </Button>
              ))}
            </div>
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("drawer.done")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ViewRow({
  view,
  label,
  onRename,
  onRemove,
}: {
  view: ResolvedConversationView
  label: string
  onRename: (id: string, name: string) => void
  onRemove: (id: string) => void
}) {
  const t = useTranslations("conversationFilters")
  const [draft, setDraft] = useState(label)
  const commit = () => {
    const next = draft.trim()
    if (next && next !== label) onRename(view.id, next)
    else setDraft(label)
  }
  // A built-in's name is a translation key, so it cannot be edited in place —
  // renaming it would either break the key or strand the row in one locale.
  if (view.builtIn) {
    return (
      <li className="flex items-center gap-2 px-1">
        <span className="flex-1 truncate text-sm">{label}</span>
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {t("views.builtInBadge")}
        </span>
        <Button
          size="icon"
          variant="ghost"
          className="size-9 shrink-0 text-muted-foreground hover:text-destructive"
          aria-label={t("views.hide", { name: label })}
          onClick={() => onRemove(view.id)}
        >
          <EyeOffIcon className="size-4" />
        </Button>
      </li>
    )
  }
  return (
    <li className="flex items-center gap-2">
      <Input
        value={draft}
        maxLength={CONVERSATION_VIEW_NAME_MAX}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault()
            commit()
            event.currentTarget.blur()
          } else if (event.key === "Escape") {
            event.preventDefault()
            setDraft(label)
          }
        }}
        aria-label={t("views.rename", { name: label })}
        className="h-9"
      />
      <Button
        size="icon"
        variant="ghost"
        className="size-9 shrink-0 text-muted-foreground hover:text-destructive"
        aria-label={t("views.delete", { name: label })}
        onClick={() => onRemove(view.id)}
      >
        <Trash2Icon className="size-4" />
      </Button>
    </li>
  )
}

// ---------------------------------------------------------------------------
// Search reach
// ---------------------------------------------------------------------------

export interface ConversationSearchScopeControlProps {
  model: Pick<ConversationFilterViewModel, "search" | "actions">
  /** Where the desktop menu opens relative to the trigger. Defaults to `"right"`. */
  side?: "right" | "left" | "top" | "bottom"
  triggerClassName?: string
  testId?: string
}

/**
 * How far the search field looks: workspaces, archived rows, message content.
 *
 * One control for three axes that used to be decided in three unrelated places
 * — the archived *view* toggle, the *grouping* axis, and a settings switch —
 * which meant whether you could find a conversation depended on how you had
 * chosen to group the list. It sits beside the field it governs, and the badge
 * counts the axes widened past their default so a reach left on last week is
 * never invisible.
 *
 * Same dropdown shell as the filter menu rather than a second popover idiom:
 * the two buttons sit next to each other and would read as different kinds of
 * thing otherwise.
 */
export function ConversationSearchScopeControl({
  model,
  side = "right",
  triggerClassName,
  testId = "conversation-search-scope",
}: ConversationSearchScopeControlProps) {
  const t = useTranslations("conversationFilters")
  const { search, actions } = model
  const widened = countWidenedSearchAxes(search)
  const label =
    widened > 0 ? t("searchScope.labelActive", { count: widened }) : t("searchScope.label")
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label={label}
          title={label}
          className={cn("relative", triggerClassName)}
          data-testid={testId}
        >
          <TelescopeIcon className="size-4" />
          {widened > 0 ? (
            <span
              aria-hidden
              className="absolute top-1 right-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-0.5 text-[9px] leading-none font-semibold text-primary-foreground tabular-nums"
              data-testid={`${testId}-dot`}
            >
              {widened}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side={side}
        align="start"
        sideOffset={6}
        collisionPadding={8}
        className="w-64"
        data-testid={`${testId}-menu`}
      >
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          {t("searchScope.hint")}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs">
          {t("searchScope.workspace.label")}
        </DropdownMenuLabel>
        {CONVERSATION_SEARCH_WORKSPACE_OPTIONS.map((option) => (
          <DropdownMenuCheckboxItem
            key={option}
            checked={search.workspace === option}
            onSelect={keepOpen}
            onCheckedChange={() => actions.setSearchOptions({ workspace: option })}
            data-testid={`${testId}-workspace-${option}`}
          >
            {t(`searchScope.workspace.${option}`)}
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={search.includeArchived}
          onSelect={keepOpen}
          onCheckedChange={(checked) => actions.setSearchOptions({ includeArchived: checked })}
          data-testid={`${testId}-archived`}
        >
          {t("searchScope.includeArchived")}
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={search.content}
          onSelect={keepOpen}
          onCheckedChange={(checked) => actions.setSearchOptions({ content: checked })}
          data-testid={`${testId}-content`}
        >
          {t("searchScope.content")}
        </DropdownMenuCheckboxItem>
        {search.content ? (
          <DropdownMenuLabel className="pt-0 text-[11px] font-normal text-muted-foreground">
            {t("searchScope.contentHint", { count: CONTENT_SEARCH_MIN_QUERY })}
          </DropdownMenuLabel>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// ---------------------------------------------------------------------------
// Chips
// ---------------------------------------------------------------------------

export interface ConversationFilterChipsProps {
  model: ConversationFilterViewModel
  /** Conversations currently rendered. */
  shown: number
  /** Conversations in this view before filters — the denominator. */
  total: number
  className?: string
  testId?: string
}

/** How many facet values a chip names before collapsing the rest into "+N". */
const CHIP_VALUE_LIMIT = 2

/**
 * Removable chips for whatever is currently narrowing the list, plus the
 * shown/total count.
 *
 * This is the price of persisting filters across reloads: the state has to be
 * visible and one click from gone, or a list narrowed weeks ago reads as data
 * loss. A non-default sort gets its own (non-removable) chip for the same
 * reason — "why is my newest chat at the bottom" is the same confusion. When
 * the active filters equal a saved preset, one chip carrying the preset's
 * name replaces the facet-by-facet breakdown.
 *
 * Renders nothing when the list is in its default, unnarrowed state.
 */
export function ConversationFilterChips({
  model,
  shown,
  total,
  className,
  testId = "conversation-filter-chips",
}: ConversationFilterChipsProps) {
  const t = useTranslations("conversationFilters")
  const labelOf = useViewLabel()
  const { filters, activeFilters, sortBy, options, activeView, activeViewDrift, actions } = model
  const sortPinned = sortBy !== DEFAULT_CONVERSATION_SORT_BY
  const modified = activeViewDrift.length > 0
  if (activeFilters === 0 && !sortPinned && !activeView) return null

  const chips: ReactNode[] = []
  // Inside a view, its name replaces the facet-by-facet breakdown — that is
  // what the user named the combination for. Once they nudge something the
  // chip says so and offers the way back, rather than silently dropping the
  // view and leaving them to work out which of ten facets moved.
  if (activeView && !modified) {
    chips.push(
      <FilterChip
        key="view"
        icon={BookmarkIcon}
        label={labelOf(activeView)}
        removeLabel={t("views.clear")}
        onRemove={actions.clearView}
      />
    )
  } else if (activeView) {
    chips.push(
      <FilterChip
        key="view"
        icon={BookmarkIcon}
        label={t("views.modifiedChip", { name: labelOf(activeView) })}
        title={t("views.revert")}
        removeLabel={t("views.clear")}
        onRemove={actions.clearView}
        onClick={actions.revertView}
        testId={`${testId}-view-modified`}
      />
    )
  }
  if (activeView && !modified) {
    // Nothing more to say: every facet on screen is the view's own.
  } else {
    for (const key of CONVERSATION_FILTER_TOGGLES) {
      if (!filters[key]) continue
      const label = t(`filters.options.${key}`)
      chips.push(
        <FilterChip
          key={key}
          label={label}
          removeLabel={t("remove", { name: label })}
          onRemove={() => actions.toggle(key, false)}
        />
      )
    }
    if (filters.kind !== "all") {
      const label = t(`kind.options.${filters.kind}`)
      chips.push(
        <FilterChip
          key="kind"
          label={label}
          removeLabel={t("remove", { name: label })}
          onRemove={() => actions.setKind("all")}
        />
      )
    }
    for (const key of CONVERSATION_FILTER_LIST_KEYS) {
      const selected = filters[key]
      if (selected.length === 0) continue
      const meta = LIST_FACET_META[key]
      const byValue = new Map(options[key].map((option) => [option.value, option]))
      const names = selected.map((value) => {
        if (value === CONVERSATION_FILTER_UNASSIGNED) return t(`${meta.ns}.unassigned`)
        return byValue.get(value)?.label ?? value
      })
      const head = names.slice(0, CHIP_VALUE_LIMIT).join(", ")
      const rest = names.length - CHIP_VALUE_LIMIT
      const values = rest > 0 ? `${head} +${rest}` : head
      const facet = t(`${meta.ns}.label`)
      const label = `${facet}: ${values}`
      chips.push(
        <FilterChip
          key={key}
          label={label}
          title={`${facet}: ${names.join(", ")}`}
          removeLabel={t("remove", { name: facet })}
          onRemove={() => actions.setList(key, [])}
        />
      )
    }
    if (filters.activity !== "any") {
      const label = t(`activity.options.${filters.activity}`)
      chips.push(
        <FilterChip
          key="activity"
          label={label}
          removeLabel={t("remove", { name: label })}
          onRemove={() => actions.setActivity("any")}
        />
      )
    }
  }

  return (
    <div className={cn("flex flex-wrap items-center gap-1", className)} data-testid={testId}>
      {sortPinned ? (
        <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
          <ArrowDownUpIcon className="size-2.5" aria-hidden />
          {t(`sort.options.${sortBy}`)}
        </span>
      ) : null}
      {chips}
      {activeFilters > 0 ? (
        <>
          <span
            className="ml-auto text-[10px] text-muted-foreground tabular-nums"
            data-testid={`${testId}-count`}
          >
            {t("count", { shown, total })}
          </span>
          <Button
            size="xs"
            variant="ghost"
            className="h-5 px-1.5 text-[10px] text-muted-foreground"
            onClick={actions.reset}
          >
            {t("clearAll")}
          </Button>
        </>
      ) : null}
    </div>
  )
}

function FilterChip({
  icon: Icon,
  label,
  title,
  removeLabel,
  onRemove,
  onClick,
  testId,
}: {
  icon?: LucideIcon
  label: string
  title?: string
  removeLabel: string
  onRemove: () => void
  /**
   * Optional action on the chip's body, separate from removing it. Used by the
   * "modified" view chip, whose body puts the view back while its × leaves the
   * view — two different exits that must not be one control.
   */
  onClick?: () => void
  testId?: string
}) {
  return (
    <span
      className="inline-flex max-w-full items-center gap-1 rounded-full bg-primary/15 py-0.5 pr-0.5 pl-2 text-[10px] text-primary"
      title={title}
      data-testid={testId}
    >
      {Icon ? <Icon className="size-2.5 shrink-0" aria-hidden /> : null}
      {onClick ? (
        <button type="button" onClick={onClick} title={title} className="truncate hover:underline">
          {label}
        </button>
      ) : (
        <span className="truncate">{label}</span>
      )}
      <button
        type="button"
        onClick={onRemove}
        aria-label={removeLabel}
        className="flex size-3.5 shrink-0 items-center justify-center rounded-full hover:bg-primary/25"
      >
        <XIcon className="size-2.5" />
      </button>
    </span>
  )
}
