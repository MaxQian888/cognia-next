"use client"

/**
 * A `MenuKit` (`components/shared/menu-kit.tsx`) for the mobile action sheet:
 * the conversation row's menu items (`SessionRowMenuItems`) rendered as the
 * sheet's large touch rows instead of a Radix menu, so the phone offers the
 * exact item set, order and lock handling the desktop row menus do.
 *
 * A submenu has no room to fly out on a phone; it becomes a second page of the
 * same sheet. `Sub` names a page, `SubTrigger` turns to it, and `SubContent`
 * draws it (with a Back row) only while it is the page on screen — every
 * other item draws only on the page it belongs to. Choosing an item closes the
 * sheet first (`onPicked`), then acts, so an action that opens the next
 * surface (the rename field, a dialog) is not covered by the closing sheet.
 *
 * Wrap the items in `SessionRowSheetMenu`.
 */

import {
  createContext,
  useContext,
  useId,
  useState,
  type ComponentType,
  type ReactNode,
} from "react"
import { useTranslations } from "next-intl"
import { ArrowLeftIcon, ChevronRightIcon } from "lucide-react"

import type { MenuKit, MenuKitItemProps } from "@/components/shared/menu-kit"
import { cn } from "@/lib/utils"

const MAIN_PAGE = "main"

interface SheetMenuState {
  page: string
  setPage: (page: string) => void
  onPicked: () => void
}

const SheetMenuContext = createContext<SheetMenuState | null>(null)
/** The page an item belongs to: the main page, or its submenu's. */
const OwnPageContext = createContext<string>(MAIN_PAGE)
/** The page a `SubTrigger` / `SubContent` pair opens. */
const SubPageContext = createContext<string | null>(null)

function useSheetMenu(): SheetMenuState {
  const state = useContext(SheetMenuContext)
  if (!state) throw new Error("SHEET_MENU_KIT parts must render inside <SessionRowSheetMenu>")
  return state
}

/** Whether the calling part's page is the one on screen. */
function useOnPage(): boolean {
  return useSheetMenu().page === useContext(OwnPageContext)
}

export function SessionRowSheetMenu({
  label,
  onPicked,
  children,
}: {
  /** The group's accessible name (the conversation's title). */
  label: string
  /** An item was chosen — close the sheet. */
  onPicked: () => void
  children: ReactNode
}) {
  const [page, setPage] = useState(MAIN_PAGE)
  return (
    <SheetMenuContext.Provider value={{ page, setPage, onPicked }}>
      <div className="flex flex-col px-2 pb-3" role="group" aria-label={label}>
        {children}
      </div>
    </SheetMenuContext.Provider>
  )
}

const ROW_CLASS = cn(
  "flex min-h-12 w-full min-w-0 items-center gap-3 rounded-md px-3 text-left text-base outline-none",
  "active:bg-accent focus-visible:ring-2 focus-visible:ring-ring pointer-fine:hover:bg-accent/60",
  "disabled:pointer-events-none disabled:opacity-50",
  // The shared items size their icons for a desktop menu; a touch row wants
  // them larger and spaced by the row's gap instead.
  "[&_svg]:size-5 [&_svg]:shrink-0 [&>svg]:mr-0"
)

function SheetItem({
  children,
  disabled,
  className,
  title,
  onSelect,
  onClick,
  "aria-current": ariaCurrent,
  "data-testid": testId,
}: MenuKitItemProps) {
  const { onPicked } = useSheetMenu()
  if (!useOnPage()) return null
  return (
    <button
      type="button"
      disabled={disabled}
      title={title}
      aria-current={ariaCurrent}
      data-testid={testId}
      className={cn(ROW_CLASS, className)}
      onClick={(event) => {
        onPicked()
        onSelect?.(new Event("select"))
        onClick?.(event)
      }}
    >
      {children}
    </button>
  )
}

function SheetLabel({ children }: { children?: ReactNode; className?: string }) {
  if (!useOnPage()) return null
  return (
    <p
      role="note"
      className="mx-2 mb-2 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm [&_svg]:mt-0.5 [&_svg]:size-4"
    >
      {children}
    </p>
  )
}

/**
 * A plain group heading on the page it belongs to ("Characters", "Teams").
 * Not part of `MenuKit` — `Label` above is the sheet's warning note — but
 * exported for item lists that head their groups (the Inbox triage lists).
 */
export function SheetHeading({ children }: { children?: ReactNode; className?: string }) {
  if (!useOnPage()) return null
  return (
    <p className="px-3 pt-2 pb-1 text-xs font-medium text-muted-foreground">{children}</p>
  )
}

function SheetSeparator() {
  if (!useOnPage()) return null
  return <div role="separator" className="mx-3 my-1 h-px bg-border" />
}

function SheetSub({ children }: { children?: ReactNode }) {
  const id = useId()
  return <SubPageContext.Provider value={id}>{children}</SubPageContext.Provider>
}

function SheetSubTrigger({
  children,
  disabled,
  "data-testid": testId,
}: {
  children?: ReactNode
  disabled?: boolean
  "data-testid"?: string
}) {
  const { setPage } = useSheetMenu()
  const target = useContext(SubPageContext)
  if (!useOnPage() || !target) return null
  return (
    <button
      type="button"
      disabled={disabled}
      data-testid={testId}
      className={ROW_CLASS}
      onClick={() => setPage(target)}
    >
      {children}
      <ChevronRightIcon className="ml-auto text-muted-foreground" aria-hidden />
    </button>
  )
}

function SheetSubContent({ children }: { children?: ReactNode; className?: string }) {
  const t = useTranslations("common")
  const { page, setPage } = useSheetMenu()
  const target = useContext(SubPageContext)
  if (!target || page !== target) return null
  return (
    <>
      <button
        type="button"
        className={ROW_CLASS}
        onClick={() => setPage(MAIN_PAGE)}
        data-testid="session-row-sheet-back"
      >
        <ArrowLeftIcon aria-hidden />
        <span>{t("back")}</span>
      </button>
      <OwnPageContext.Provider value={target}>
        <div className="max-h-[50vh] overflow-y-auto">{children}</div>
      </OwnPageContext.Provider>
    </>
  )
}

/** A phone has no shortcut keys to hint at. */
const NoShortcut: ComponentType<{ children?: ReactNode }> = () => null

export const SHEET_MENU_KIT: MenuKit = {
  Item: SheetItem,
  Label: SheetLabel,
  Separator: SheetSeparator,
  Sub: SheetSub,
  SubTrigger: SheetSubTrigger,
  SubContent: SheetSubContent,
  Shortcut: NoShortcut,
}
