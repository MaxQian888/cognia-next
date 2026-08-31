"use client"

/**
 * "Me" tab (Wave 2.4 → /me iOS-style refactor → search + favorites + adaptive
 * layout).
 *
 * iOS Settings layout:
 *   ┌─ Header (sticky)                                  ─┐
 *   │  我的                              [ConnectionBadge]│
 *   ├─ Search (filters the grouped rows)                 ┤
 *   ├─ AccountCard  (live identity + 5h/7d usage)        ┤
 *   ├─ TodayStatsCard  (sessions · drafts · backup · 存储)┤
 *   ├─ QuickActionGrid (theme · lang · CU · scan)        ┤
 *   ├─ TransportTierIndicator (how we reach the desktop) ┤
 *   ├─ NotificationPermissionCta (auto-hides when granted)┤
 *   ├─ MeSection: 常用 (pinned rows, when any)           ┤
 *   ├─ MeSection × 6 (account / appearance / connection / ┤
 *   │                 automation / data / about)          │
 *   └─ SignOutButton (biometric-gated, clears both)      ┘
 *
 * The grouped rows are data-driven from `me-entries.ts` so the same list
 * powers rendering, search (`matchMeEntry`) and pin/favorite
 * (`usePinnedMeRows`). Long-press any row to toggle its pin. Conditional /
 * dynamic rows (Pair, Devices' short id, Sync's last-synced stamp, the
 * Version row) stay inline. On tablets / landscape the content clamps to a
 * centered max width and the sections flow into two columns.
 */

import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { motion, useReducedMotion } from "motion/react"
import { ScanIcon } from "lucide-react"

import { STAGGER_CHILD, STAGGER_CONTAINER } from "@/lib/ui/motion"
import { cn } from "@/lib/utils"
import { AccountCard } from "@/components/mobile/me/account-card"
import { BackupReminderBanner } from "@/components/mobile/me/backup-reminder-banner"
import { MeRow } from "@/components/mobile/me/me-row"
import { MeSection } from "@/components/mobile/me/me-section"
import { QuickActionGrid } from "@/components/mobile/me/quick-action-grid"
import { SignOutButton } from "@/components/mobile/me/sign-out-button"
import { TodayStatsCard } from "@/components/mobile/me/today-stats-card"
import { TransportTierIndicator } from "@/components/mobile/me/transport-tier-indicator"
import { MobileTabCustomizer } from "@/components/mobile/shell/mobile-tab-customizer"
import { VersionRow } from "@/components/mobile/me/version-row"
import { ConnectionStateBadge } from "@/components/mobile/connection-state-badge"
import { DiscoverSearch } from "@/components/mobile/discover/discover-search"
import { NotificationPermissionCta } from "@/components/mobile/notifications/notification-permission-cta"
import { LongPress } from "@/components/interactions/long-press"
import {
  ME_ENTRIES,
  ME_SECTION_ORDER,
  ME_SECTION_TITLE_KEY,
  matchMeEntry,
  type MeEntry,
} from "@/components/mobile/me/me-entries"
import { usePinnedMeRows } from "@/components/mobile/me/use-pinned-me-rows"
import { useCompanionConfig } from "@/hooks/companion/use-companion-config"
import { useCompactLayout } from "@/hooks/ui/use-compact-layout"
import { snapshotSyncStates } from "@/lib/sync/companion-sync"
import { formatRelative } from "@cognia/time"

export default function MePage() {
  const t = useTranslations("mobile.me")
  // `/me` is the phone-shaped settings hub. It used to be gated on the
  // Capacitor runtime, which meant a 375px browser was redirected away from
  // the only settings surface that fits it, into the desktop shell it cannot
  // render. Width is the right question here.
  const compact = useCompactLayout()
  const router = useRouter()
  const [mounted, setMounted] = useState(false)
  const [scrolled, setScrolled] = useState(false)
  const [query, setQuery] = useState("")
  const reduceMotion = useReducedMotion()
  const [lastSyncedLabel, setLastSyncedLabel] = useState<string | undefined>(undefined)
  const { paired, shortDeviceId } = useCompanionConfig()
  const { pinnedIds, togglePin } = usePinnedMeRows()

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true)
  }, [])

  useEffect(() => {
    if (!mounted) return
    if (compact) return
    router.replace("/settings?section=account")
  }, [compact, mounted, router])

  useEffect(() => {
    if (!mounted || !compact) return
    const states = snapshotSyncStates()
    const max = Object.values(states).reduce((acc, s) => Math.max(acc, s.lastSyncAt ?? 0), 0)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLastSyncedLabel(max > 0 ? formatRelative(max) : undefined)
  }, [compact, mounted])

  const filtered = useMemo(
    () => (query.trim() ? ME_ENTRIES.filter((e) => matchMeEntry(e, query, t)) : []),
    [query, t]
  )
  const pinnedEntries = useMemo(
    () => ME_ENTRIES.filter((e) => pinnedIds.includes(e.id)),
    [pinnedIds]
  )

  if (!mounted || !compact) return null

  /** Right-aligned dynamic value for certain rows. */
  const rowValue = (entry: MeEntry): string | undefined => {
    if (entry.id === "devices") return paired && shortDeviceId ? shortDeviceId : undefined
    if (entry.id === "sync") return lastSyncedLabel
    // ADR-0056 D2 — agent-class pages are dead UI without a paired desktop;
    // annotate the row so the user knows before tapping into the placeholder.
    if (entry.pairedOnly && !paired) return t("requiresDesktop")
    return undefined
  }

  const renderEntry = (entry: MeEntry, opts?: { favorite?: boolean }) => {
    const testid = opts?.favorite ? `me-row-fav-${entry.id}` : `me-row-${entry.id}`
    return (
      <LongPress key={testid} onLongPress={() => void togglePin(entry.id)} className="block">
        <MeRow
          icon={entry.icon}
          spotIcon={entry.spotIcon}
          label={t(entry.labelKey)}
          href={entry.href}
          value={rowValue(entry)}
          testid={testid}
        />
      </LongPress>
    )
  }

  return (
    <main
      className="flex h-full min-h-0 flex-1 flex-col overflow-y-auto bg-background safe-area-pt"
      data-testid="me-page"
      onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}
    >
      <header
        className={cn(
          "sticky top-0 z-10 border-b bg-background/95 px-4 py-3 backdrop-blur transition-shadow supports-[backdrop-filter]:bg-background/75",
          scrolled && "shadow-sm"
        )}
        data-scrolled={scrolled}
      >
        <div className="mx-auto flex w-full max-w-2xl items-center gap-2 lg:max-w-4xl">
          <h1 className="flex-1 text-2xl font-semibold tracking-tight">{t("title")}</h1>
          <ConnectionStateBadge />
        </div>
      </header>

      {/* Widen on large tablets/landscape so the lg 3-column grid below has
          room to breathe; phones keep the original max-w-2xl clamp. */}
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 pb-8 pt-3 lg:max-w-4xl">
        <DiscoverSearch
          value={query}
          onChange={setQuery}
          placeholder={t("search")}
          ariaLabel={t("searchAria")}
          testid="me-search"
        />

        {query.trim() ? (
          filtered.length > 0 ? (
            <MeSection title={t("searchResults")} testid="me-search-results">
              {filtered.map((entry) => renderEntry(entry))}
            </MeSection>
          ) : (
            <p
              className="px-1 py-10 text-center text-sm text-muted-foreground"
              data-testid="me-search-empty"
            >
              {t("searchEmpty")}
            </p>
          )
        ) : (
          <>
            <motion.section
              className="flex flex-col gap-3"
              initial={reduceMotion ? false : "initial"}
              animate="animate"
              variants={STAGGER_CONTAINER}
            >
              <motion.div variants={STAGGER_CHILD}>
                <AccountCard />
              </motion.div>
              <motion.div variants={STAGGER_CHILD}>
                <BackupReminderBanner />
              </motion.div>
              <motion.div variants={STAGGER_CHILD}>
                <TodayStatsCard />
              </motion.div>
              <motion.div variants={STAGGER_CHILD}>
                <QuickActionGrid />
              </motion.div>
              <motion.div variants={STAGGER_CHILD}>
                <TransportTierIndicator />
              </motion.div>
              <motion.div variants={STAGGER_CHILD}>
                <NotificationPermissionCta />
              </motion.div>
            </motion.section>

            {pinnedEntries.length > 0 ? (
              <MeSection title={t("sectionFavorites")} testid="me-section-favorites">
                {pinnedEntries.map((entry) => renderEntry(entry, { favorite: true }))}
              </MeSection>
            ) : null}

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {ME_SECTION_ORDER.map((section) => (
                <MeSection
                  key={section}
                  title={t(ME_SECTION_TITLE_KEY[section])}
                  testid={`me-section-${section}`}
                >
                  {section === "about" ? <VersionRow /> : null}
                  {ME_ENTRIES.filter((e) => e.section === section).map((entry) =>
                    renderEntry(entry)
                  )}
                  {section === "appearance" ? <MobileTabCustomizer /> : null}
                  {section === "account" && !paired ? (
                    <MeRow
                      icon={ScanIcon}
                      label={t("actionPair")}
                      href="/pair"
                      testid="me-row-pair"
                    />
                  ) : null}
                </MeSection>
              ))}
            </div>

            <SignOutButton className="mt-2" />
          </>
        )}
      </div>
    </main>
  )
}
