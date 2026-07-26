"use client"

/**
 * Mobile bottom Tab Bar (Wave 2.2 / WeChat-style).
 *
 * Four tabs: 聊天 / 工作流 / 发现 / 我. Each entry pushes its own route via
 * Next's router, with a haptic selectionFeedback on switch. The bar lives
 * fixed at the bottom of the viewport and respects the iOS / Android
 * safe-area inset (handled in `mobile-shell-wrapper.tsx`).
 */

import Link from "next/link"
import { usePathname } from "next/navigation"
import { useTranslations } from "next-intl"
import { CompassIcon, MessageCircleIcon, UserIcon, WorkflowIcon } from "lucide-react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { useTransition } from "react"

import { Badge } from "@/components/ui/badge"
import { selectionFeedback } from "@/lib/capacitor/haptics"
import { MOBILE_EASE, MOBILE_DURATION, MOBILE_SPRING, STAGGER_INTERVAL } from "@/lib/ui/motion"
import { cn } from "@/lib/utils"
import { useMobileTabLayout } from "./use-mobile-tab-layout"
import type { MobileTabId } from "@/types/shell/mobile-tabs"

export interface TabSpec {
  id: TabId
  href: string
  icon: typeof MessageCircleIcon
  /** Routes that should highlight this tab — partial match by prefix. */
  matchPrefixes: string[]
}

/** Stable tab ids — unified with the persisted `MobileTabId` model. */
export type TabId = MobileTabId

export const MOBILE_TABS: TabSpec[] = [
  {
    id: "chat",
    href: "/",
    icon: MessageCircleIcon,
    matchPrefixes: ["/", "/inbox"],
  },
  {
    id: "workflows",
    href: "/workflows",
    icon: WorkflowIcon,
    matchPrefixes: ["/workflows"],
  },
  {
    id: "discover",
    href: "/discover",
    icon: CompassIcon,
    matchPrefixes: ["/discover", "/agent-teams", "/twin"],
  },
  {
    id: "me",
    href: "/me",
    icon: UserIcon,
    matchPrefixes: ["/me", "/settings", "/pair"],
  },
]

/** id → spec lookup (icon, href, match prefixes). */
export const TAB_SPEC_BY_ID: Record<TabId, TabSpec> = MOBILE_TABS.reduce(
  (acc, tab) => {
    acc[tab.id] = tab
    return acc
  },
  {} as Record<TabId, TabSpec>
)

/** Launch route for a tab id (used by the default-landing redirect). */
export function tabHref(id: TabId): string {
  return TAB_SPEC_BY_ID[id]?.href ?? "/"
}

export function pickActiveTabId(pathname: string): TabId {
  // Longest matching prefix wins so "/inbox" matches "chat" but
  // "/settings/foo" matches "me", not "chat" via "/".
  let bestId: TabId = "chat"
  let bestLen = -1
  for (const tab of MOBILE_TABS) {
    for (const prefix of tab.matchPrefixes) {
      const matches =
        prefix === "/" ? pathname === "/" : pathname === prefix || pathname.startsWith(prefix + "/")
      if (matches && prefix.length > bestLen) {
        bestId = tab.id
        bestLen = prefix.length
      }
    }
  }
  return bestId
}

export interface MobileTabBarProps {
  className?: string
  /** Optional badge counts rendered as a red dot per tab. */
  badges?: Partial<Record<TabId, number>>
  /**
   * Slide the bar off-screen while the soft keyboard is open. Kept mounted
   * (CSS translate, not unmount) so the per-tab entrance stagger doesn't
   * replay on every keyboard dismiss.
   */
  keyboardHidden?: boolean
}

const MotionLink = motion.create(Link)

/**
 * Shared-layout id for the active-tab pill. One instance is mounted, inside
 * whichever tab is active; motion animates it *between* stops rather than
 * cross-fading two of them, which is what makes the bar read as one control
 * instead of four independent links.
 */
const INDICATOR_LAYOUT_ID = "mobile-tab-indicator"

export function MobileTabBar({ className, badges, keyboardHidden = false }: MobileTabBarProps) {
  const pathname = usePathname() ?? "/"
  const activeId = pickActiveTabId(pathname)
  const [, startTransition] = useTransition()
  const reduce = useReducedMotion()
  const t = useTranslations("mobile.tabs")
  const tBar = useTranslations("mobile.tabBar")
  const tShell = useTranslations("mobile.shell")
  const { resolved } = useMobileTabLayout()

  // Render the user's visible tabs in their chosen order; fall back to the
  // canonical specs via the id lookup (skip any id without a spec).
  const tabs = resolved.visible
    .map((id) => TAB_SPEC_BY_ID[id])
    .filter((spec): spec is TabSpec => Boolean(spec))

  const onTap = () => {
    // Light haptic on every tab press; failure = no-op on non-mobile.
    void selectionFeedback()
  }

  return (
    <nav
      className={cn(
        // `min-h-14` instead of fixed `h-14` so a longer translated label
        // (e.g. Chinese 工作流 keeps fine, but future locales may wrap) never
        // clips the icon; each link still reserves 56px so the existing
        // `pb-[calc(theme(spacing.14)+env(safe-area-inset-bottom))]` reserve
        // stays correct.
        "fixed inset-x-0 bottom-0 z-40 flex h-14 min-h-14 items-stretch border-t border-border bg-background/95 backdrop-blur safe-area-pb",
        "transition-transform duration-200 ease-out",
        keyboardHidden && "pointer-events-none translate-y-full",
        className
      )}
      role="tablist"
      aria-label={tShell("tabBarAria")}
      aria-hidden={keyboardHidden || undefined}
      data-testid="mobile-tab-bar"
      data-keyboard-hidden={keyboardHidden ? "true" : "false"}
    >
      {tabs.map((tab, index) => {
        const Icon = tab.icon
        const active = tab.id === activeId
        const badge = badges?.[tab.id] ?? 0
        return (
          <MotionLink
            key={tab.id}
            href={tab.href}
            role="tab"
            aria-selected={active}
            aria-current={active ? "page" : undefined}
            data-testid={`mobile-tab-${tab.id}`}
            onClick={() => {
              onTap()
              startTransition(() => {})
            }}
            initial={reduce ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{
              duration: MOBILE_DURATION.fast,
              ease: MOBILE_EASE,
              delay: reduce ? 0 : index * STAGGER_INTERVAL,
            }}
            // Press feedback. A tab bar is the one control a phone user hits
            // dozens of times a session; without a tap state the bar feels
            // dead between the touch and the route actually swapping.
            whileTap={reduce ? undefined : { scale: 0.9 }}
            className={cn(
              // `min-h-[44px]` enforces the iOS HIG / WCAG touch-target
              // floor on dense screens; the parent already sets h-14 (56px)
              // so this is belt-and-braces for landscape orientations where
              // the nav can otherwise compress.
              "relative flex min-h-[44px] flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium",
              "transition-colors duration-200",
              active ? "text-primary" : "text-muted-foreground"
            )}
          >
            <span className="relative flex flex-col items-center gap-0.5">
              {/* The pill sits behind the icon only (not the label) so the
                  bar keeps its airy weighting; `layoutId` slides the single
                  instance across on every switch. */}
              {active ? (
                <motion.span
                  layoutId={reduce ? undefined : INDICATOR_LAYOUT_ID}
                  data-testid="mobile-tab-indicator"
                  aria-hidden="true"
                  className="absolute -top-0.5 left-1/2 -z-10 h-7 w-12 -translate-x-1/2 rounded-full bg-primary/10"
                  transition={MOBILE_SPRING}
                />
              ) : null}
              <span className="relative">
                <motion.span
                  className="block"
                  // The icon lifts a hair on activation. Scale, not a colour
                  // change alone — colour is easy to miss on a small glyph at
                  // low contrast.
                  animate={reduce ? undefined : { scale: active ? 1.12 : 1 }}
                  transition={MOBILE_SPRING}
                >
                  <Icon className="size-5" aria-hidden="true" />
                </motion.span>
                <AnimatePresence initial={false}>
                  {badge > 0 ? (
                    <motion.span
                      key="badge"
                      className="absolute -right-1.5 -top-0.5"
                      initial={reduce ? false : { scale: 0, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      exit={reduce ? { opacity: 0 } : { scale: 0, opacity: 0 }}
                      transition={MOBILE_SPRING}
                    >
                      <Badge
                        variant="destructive"
                        data-testid={`mobile-tab-badge-${tab.id}`}
                        aria-label={tBar("unread", { count: badge })}
                        className="h-4 min-w-[16px] rounded-full px-1 text-[9px] font-semibold"
                      >
                        {badge > 99 ? "99+" : badge}
                      </Badge>
                    </motion.span>
                  ) : null}
                </AnimatePresence>
              </span>
            </span>
            <span className="max-w-full truncate px-0.5 leading-tight">{t(tab.id)}</span>
          </MotionLink>
        )
      })}
    </nav>
  )
}
