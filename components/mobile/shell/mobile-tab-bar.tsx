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
import { useTransition } from "react"

import { selectionFeedback } from "@/lib/capacitor/haptics"
import { cn } from "@/lib/utils"

export interface TabSpec {
  id: TabId
  href: string
  icon: typeof MessageCircleIcon
  /** Routes that should highlight this tab — partial match by prefix. */
  matchPrefixes: string[]
}

export type TabId = "chat" | "workflows" | "discover" | "me"

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
}

export function MobileTabBar({ className, badges }: MobileTabBarProps) {
  const pathname = usePathname() ?? "/"
  const activeId = pickActiveTabId(pathname)
  const [, startTransition] = useTransition()
  const t = useTranslations("mobile.tabs")
  const tBar = useTranslations("mobile.tabBar")
  const tShell = useTranslations("mobile.shell")

  const onTap = () => {
    // Light haptic on every tab press; failure = no-op on non-mobile.
    void selectionFeedback()
  }

  return (
    <nav
      className={cn(
        "fixed inset-x-0 bottom-0 z-40 flex h-14 items-stretch border-t border-border bg-background/95 backdrop-blur safe-area-pb",
        className
      )}
      role="tablist"
      aria-label={tShell("tabBarAria")}
      data-testid="mobile-tab-bar"
    >
      {MOBILE_TABS.map((tab) => {
        const Icon = tab.icon
        const active = tab.id === activeId
        const badge = badges?.[tab.id] ?? 0
        return (
          <Link
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
            className={cn(
              "relative flex flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium",
              active ? "text-primary" : "text-muted-foreground"
            )}
          >
            <span className="relative">
              <Icon className="size-5" aria-hidden="true" />
              {badge > 0 && (
                <span
                  data-testid={`mobile-tab-badge-${tab.id}`}
                  aria-label={tBar("unread", { count: badge })}
                  className="absolute -right-1.5 -top-0.5 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-destructive px-1 text-[9px] font-semibold text-destructive-foreground"
                >
                  {badge > 99 ? "99+" : badge}
                </span>
              )}
            </span>
            <span>{t(tab.id)}</span>
          </Link>
        )
      })}
    </nav>
  )
}
