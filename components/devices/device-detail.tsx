"use client"

/**
 * The detail pane: one device, one continuous dashboard.
 *
 * There are no tabs. Five of them meant every question cost a click and hid
 * that most answers are two lines long. As one scroll the sections are cards
 * in a grid, so the short ones sit beside each other and the wide ones
 * (matrices, registries) take the full width, and nothing is behind a click.
 *
 * What goes in the grid, and in what order, is `planDeviceSections`: per kind,
 * task-first, with half-width cards kept in pairs and every card that would
 * only have said "not here" folded into one record at the end. This file maps
 * the plan's ids to components and nothing else, so the order is decided in
 * one pure, tested place, and the jump strip in the masthead lists exactly the
 * cards the grid rendered.
 *
 * Layout rules carried over from `components/settings/mcp/mcp-panel.tsx` and
 * `@container/memory-pane`:
 *
 *  * The scroll container is `@container/device-pane`, and everything
 *    multi-column inside sizes off *that*, never the viewport. This pane is a
 *    draggable fraction of the window (18–40% goes to the rail), so a viewport
 *    `sm:` here seats two columns in a 300px pane purely because the monitor
 *    is wide.
 *  * The masthead is outside the scroller, so the device you are looking at,
 *    its actions and the jump strip stay on screen however far down you are.
 *  * Switching devices resets the scroll. Carrying the old offset lands you in
 *    the middle of a different machine's dispatch queue with no way to tell
 *    that is what happened.
 */

import { useEffect, useMemo, useRef } from "react"
import { useTranslations } from "next-intl"
import { TerminalIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { useScrollSpy } from "@/hooks/ui/use-scroll-spy"
import {
  NOT_APPLICABLE_SECTION_ID,
  planDeviceSections,
  type DeviceSectionId,
} from "@/lib/devices/section-plan"
import type { DeviceRow } from "@/lib/devices/types"
import type { DeviceGrantActions } from "@/hooks/devices/use-device-grant-actions"

import { DeviceHero, DeviceStatSummary } from "./device-hero"
import { DeviceSection } from "./device-section"
import { DeviceSectionNav, type DeviceSectionNavItem } from "./device-section-nav"
import { SshHostControls } from "./ssh-host-controls"
import { AccessSection } from "./sections/access-section"
import { DispatchSection, PlacementSection } from "./sections/activity-section"
import { CapabilitiesSection } from "./sections/capabilities-section"
import { FilesSection } from "./sections/files-section"
import { NotApplicableSection } from "./sections/not-applicable-section"
import { EventPlaneSection, IdentitySection, PresenceSection } from "./sections/overview-section"
import {
  RoutingSection,
  SandboxSection,
  ShellTiersSection,
  WorkspacesSection,
} from "./sections/runtime-section"
import { WanSection } from "./sections/wan-section"

/** The DOM id every card carries, from `DeviceSection` (`idPrefix`). */
export function deviceSectionAnchor(id: string): string {
  return `device-section-${id}`
}

/**
 * The jump strip's label for each card: its own title, so the chip and the
 * card it lands on read the same.
 */
const SECTION_LABEL_KEY: Record<DeviceSectionId, string> = {
  ssh: "ssh.title",
  files: "files.title",
  access: "access.title",
  wan: "wan.title",
  routing: "runtime.routing",
  "shell-tiers": "runtime.shellTiers",
  sandbox: "runtime.sandbox",
  workspaces: "runtime.workspaces",
  identity: "overview.identity",
  presence: "overview.presence",
  "event-plane": "overview.eventPlane",
  capabilities: "capabilities.title",
  dispatch: "activity.dispatch",
  placement: "activity.placement",
}

export interface DeviceDetailProps {
  row: DeviceRow | null
  actions: DeviceGrantActions
  /**
   * Opens the add-host sheet. A revoked host can only be paired again, not
   * reconnected, so the masthead needs a way back to the flow that pairs one.
   */
  onRepairHost?: () => void
  /**
   * A section id a deep link asked for (`?deviceSection=`). Scrolled to once the
   * row's plan includes it, then reported through `onInitialSectionApplied` so
   * the link can drop it. A section the plan does not hold is reported too:
   * holding on to it would scroll the pane the next time the row changed.
   */
  initialSection?: string | null
  onInitialSectionApplied?: () => void
}

function PlannedSection({
  id,
  row,
  actions,
}: {
  id: DeviceSectionId
  row: DeviceRow
  actions: DeviceGrantActions
}) {
  const t = useTranslations("devices")
  switch (id) {
    case "ssh":
      // Full width because of what it holds: the identity record, the
      // forwarding rules and three controls. In half a pane that is a 700px
      // ribbon beside a 90px stub.
      return (
        <DeviceSection id="ssh" title={t("ssh.title")} icon={TerminalIcon} wide>
          <SshHostControls row={row} />
        </DeviceSection>
      )
    case "files":
      return <FilesSection row={row} />
    case "access":
      return <AccessSection row={row} actions={actions} />
    case "wan":
      return <WanSection row={row} />
    case "routing":
      return <RoutingSection row={row} />
    case "shell-tiers":
      return <ShellTiersSection row={row} />
    case "sandbox":
      return <SandboxSection row={row} />
    case "workspaces":
      return <WorkspacesSection row={row} />
    case "identity":
      return <IdentitySection row={row} />
    case "presence":
      return <PresenceSection row={row} />
    case "event-plane":
      return <EventPlaneSection row={row} />
    case "capabilities":
      return <CapabilitiesSection row={row} />
    case "dispatch":
      return <DispatchSection row={row} />
    case "placement":
      return <PlacementSection row={row} />
  }
}

export function DeviceDetail({
  row,
  actions,
  onRepairHost,
  initialSection,
  onInitialSectionApplied,
}: DeviceDetailProps) {
  const t = useTranslations("devices")
  const ref = row?.ref ?? null

  const plan = useMemo(() => (row ? planDeviceSections(row) : null), [row])

  const navItems = useMemo<DeviceSectionNavItem[]>(() => {
    if (!plan) return []
    const items = plan.sections.map((section) => ({
      anchor: deviceSectionAnchor(section.id),
      label: t(SECTION_LABEL_KEY[section.id]),
    }))
    if (plan.notApplicable.length > 0) {
      items.push({
        anchor: deviceSectionAnchor(NOT_APPLICABLE_SECTION_ID),
        label: t("notApplicable.nav"),
      })
    }
    return items
  }, [plan, t])

  const anchors = useMemo(() => navItems.map((item) => item.anchor), [navItems])
  const {
    rootRef: scroller,
    activeId,
    scrollTo,
  } = useScrollSpy<HTMLDivElement>({ ids: anchors, resetKey: ref })

  /**
   * The link applied last, as `<ref>|<section>`. The jump re-renders this pane
   * (the spy marks the new section active) before the parent has dropped the
   * parameter, and without this the same link would be applied again.
   */
  const appliedLink = useRef<string | null>(null)
  useEffect(() => {
    if (!initialSection || !plan) return
    const key = `${ref}|${initialSection}`
    if (appliedLink.current === key) return
    appliedLink.current = key
    const anchor = deviceSectionAnchor(initialSection)
    if (anchors.includes(anchor)) scrollTo(anchor)
    onInitialSectionApplied?.()
  }, [anchors, initialSection, onInitialSectionApplied, plan, ref, scrollTo])

  if (!row || !plan) {
    return (
      <Empty className="h-full border-none" data-testid="device-detail-empty">
        <EmptyHeader>
          <EmptyTitle>{t("detail.noSelectionTitle")}</EmptyTitle>
          <EmptyDescription>{t("detail.noSelectionBody")}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <div
      className="@container/device-pane flex h-full min-h-0 flex-col"
      data-testid="device-detail"
      data-kind={row.kind}
    >
      <DeviceHero row={row} actions={actions} onRepairHost={onRepairHost}>
        <DeviceSectionNav items={navItems} activeAnchor={activeId} onJump={scrollTo} />
      </DeviceHero>

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-4 py-3.5">
        {/* Device-wide alerts sit above the grid, not inside a card: they are
            about the machine, not about one of the questions asked below. The
            connection error is said here once; the masthead states the
            handshake, and repeating the verbatim error there was the same
            sentence twice on one screen. */}
        {row.adminStateConflict ? (
          <Alert variant="destructive" className="mb-3.5" data-testid="device-admin-conflict">
            <AlertTitle>{t("overview.conflictTitle")}</AlertTitle>
            <AlertDescription>{t("overview.conflictBody")}</AlertDescription>
          </Alert>
        ) : null}
        {row.connectionError ? (
          <Alert variant="destructive" className="mb-3.5" data-testid="device-connection-error">
            <AlertTitle>{t("overview.connectionErrorTitle")}</AlertTitle>
            <AlertDescription className="break-all">{row.connectionError}</AlertDescription>
          </Alert>
        ) : null}

        <DeviceStatSummary row={row} className="mb-3.5" />

        {/* `items-start` so a short card keeps its own height instead of being
            stretched to match the tall one beside it — equal-height rows of
            mostly empty card is the classic dashboard-grid failure. Pairing
            the half-width cards is the plan's job (`packHalfSections`), which
            keeps reading order and visual order the same. */}
        <div className="grid items-start gap-3.5 @3xl/device-pane:grid-cols-2">
          {plan.sections.map((section) => (
            <PlannedSection key={section.id} id={section.id} row={row} actions={actions} />
          ))}
          <NotApplicableSection
            kind={row.kind}
            entries={plan.notApplicable}
            wide={plan.notApplicableWide}
          />
        </div>
      </div>
    </div>
  )
}
