"use client"

/**
 * The expanded sidebar's bottom row: who you are, and everything that hangs off
 * that.
 *
 * It replaces the lone Settings row the rail used to end on. A gear was the
 * only thing the footer said, while the account it belongs to (the local
 * profile, the cloud identity bound to it, the vault lock that protects both)
 * was reachable only from a 24px glyph in the status bar. The rail ends on a
 * person now, and Settings is one line inside the menu that person opens.
 *
 * Two identities meet here and neither is dropped. The local profile
 * (`useAccountStore`) is what the vault is keyed to and is always present. The
 * cloud identity (ADR-0149) is present only once the profile is bound to a
 * Logto session, and it is what the name and the organization badge come from
 * when it is. A profile with no cloud binding says so and offers the way in
 * rather than showing a blank.
 *
 * The usage meter is read lazily, on open. `StatusBarUsage` already queries the
 * same aggregate on mount, and both go through the shared coalescer, so asking
 * again here at mount time would buy a number nobody is looking at yet.
 */

import { useCallback, useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import {
  ChevronsUpDownIcon,
  CloudIcon,
  GaugeIcon,
  LaptopIcon,
  LockKeyholeIcon,
  SettingsIcon,
  UserRoundIcon,
  UsersRoundIcon,
} from "lucide-react"
import { toast } from "sonner"

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Separator } from "@/components/ui/separator"
import { Kbd } from "@/components/ui/kbd"
import { AccountManageDialog } from "@/components/account/account-manage-dialog"
import { RuntimeTargetMenuSection } from "@/components/account/runtime-target-menu-section"
import { useSidebarIdentity } from "@/hooks/shell/use-sidebar-identity"
import { toggleDesktopPetWindow } from "@/lib/pet/commands"
import { avatarColor } from "@/lib/ui/avatar"
import { cn } from "@/lib/utils"
import { loggers } from "@cognia/logging"
import { selectActiveAccount, useAccountStore } from "@/stores/account/account-store"

const log = loggers.ui

/** One line of the account menu. Shaped like the rail's rows, at menu scale. */
function MenuRow({
  icon,
  label,
  detail,
  onClick,
  testId,
}: {
  icon: React.ReactNode
  label: string
  detail?: React.ReactNode
  onClick: () => void
  testId: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-foreground transition-colors hover:bg-accent"
    >
      <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {detail ? (
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{detail}</span>
      ) : null}
    </button>
  )
}

export function SidebarUserCard({ className }: { className?: string }) {
  const t = useTranslations("desktop.sidebarUser")
  const router = useRouter()
  const lock = useAccountStore((state) => state.lock)
  const activeAccount = useAccountStore(selectActiveAccount)
  const [open, setOpen] = useState(false)
  const [manageOpen, setManageOpen] = useState(false)
  const identity = useSidebarIdentity(open)

  const displayName = identity.displayName ?? activeAccount?.displayName ?? t("noProfile")
  const initial = displayName.trim().charAt(0).toUpperCase() || "?"
  const tint = avatarColor({ name: displayName })

  const go = useCallback(
    (href: string) => {
      setOpen(false)
      router.push(href)
    },
    [router]
  )

  const togglePet = useCallback(() => {
    setOpen(false)
    void toggleDesktopPetWindow().catch((cause: unknown) => {
      log.warn("sidebar pet toggle failed", { error: String(cause) })
      toast.error(t("petFailed"))
    })
  }, [t])

  const lockVault = useCallback(() => {
    void Promise.resolve(lock())
      .then(() => setOpen(false))
      .catch((cause: unknown) =>
        toast.error(cause instanceof Error ? cause.message : t("lockFailed"))
      )
  }, [lock, t])

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={t("menuAria", { name: displayName })}
            data-testid="sidebar-user-card"
            className={cn(
              "flex h-10 w-full min-w-0 items-center gap-2.5 rounded-md px-1.5 text-left transition-colors hover:bg-accent",
              className
            )}
          >
            <span
              aria-hidden
              // The avatar is the one place the rail carries colour, so it is
              // the thing the eye finds when the footer is scanned.
              className="flex size-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white"
              style={{ backgroundColor: tint }}
              data-testid="sidebar-user-avatar"
            >
              {activeAccount?.avatarDataUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={activeAccount.avatarDataUrl}
                  alt=""
                  className="size-7 rounded-full object-cover"
                />
              ) : (
                initial
              )}
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[13px] font-medium text-foreground">
                {displayName}
              </span>
              {/* Where this profile stands, in one line. A profile with no
                  cloud binding is not an error state and does not get an
                  alarm, it gets the word for what it is. */}
              <span
                className="truncate text-[11px] text-muted-foreground"
                data-testid="sidebar-user-standing"
              >
                {identity.standing === "org"
                  ? t("standingOrg")
                  : identity.standing === "cloud"
                    ? (identity.email ?? t("standingCloud"))
                    : t("standingLocal")}
              </span>
            </span>
            <ChevronsUpDownIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          side="top"
          sideOffset={6}
          className="w-64 p-1"
          data-testid="sidebar-user-menu"
        >
          <div className="flex items-center gap-2.5 px-2 py-2">
            <span
              aria-hidden
              className="flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white"
              style={{ backgroundColor: tint }}
            >
              {initial}
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm font-medium">{displayName}</span>
              <span className="flex items-center gap-1 truncate text-[11px] text-muted-foreground">
                {identity.standing === "local" ? (
                  <LaptopIcon className="size-3 shrink-0" aria-hidden />
                ) : identity.standing === "org" ? (
                  <UsersRoundIcon className="size-3 shrink-0" aria-hidden />
                ) : (
                  <CloudIcon className="size-3 shrink-0" aria-hidden />
                )}
                <span className="truncate">
                  {identity.email ??
                    (identity.standing === "local" ? t("standingLocal") : t("standingCloud"))}
                </span>
              </span>
            </span>
          </div>
          <Separator className="my-1" />
          {/* The number the status bar shows, where the account it belongs to
              is. `null` means nothing is measured on this install, and a row
              reading "Usage" with no figure beside it is worse than no row. */}
          {identity.usagePercent !== null ? (
            <MenuRow
              icon={<GaugeIcon className="size-4" />}
              label={t("usage")}
              detail={t("usageLeft", { percent: 100 - identity.usagePercent })}
              onClick={() => go("/settings?section=subscription")}
              testId="sidebar-user-usage"
            />
          ) : null}
          {/* Also for a binding whose token lapsed or could not be read: that
              is exactly the state a sign-in answers. Not for `offline`, which
              needs patience rather than a trip to Settings. */}
          {identity.standing === "local" || identity.needsReauth ? (
            <MenuRow
              icon={<CloudIcon className="size-4" />}
              label={t("signIn")}
              onClick={() => go("/settings?section=companion")}
              testId="sidebar-user-sign-in"
            />
          ) : null}
          <MenuRow
            icon={<UserRoundIcon className="size-4" />}
            label={t("manageAccounts")}
            onClick={() => {
              setOpen(false)
              setManageOpen(true)
            }}
            testId="sidebar-user-manage"
          />
          {/* Only draws anything once a companion Host exists, so a desktop
              install that has never paired sees no dead section. */}
          <RuntimeTargetMenuSection requireCompanion onSwitched={() => setOpen(false)} />
          <Separator className="my-1" />
          <MenuRow
            icon={<span aria-hidden>🐾</span>}
            label={t("showPet")}
            onClick={togglePet}
            testId="sidebar-user-pet"
          />
          <MenuRow
            icon={<SettingsIcon className="size-4" />}
            label={t("settings")}
            detail={
              <Kbd aria-hidden className="text-[10px]">
                ⌘,
              </Kbd>
            }
            onClick={() => go("/settings")}
            testId="sidebar-user-settings"
          />
          {/* Cognia's "sign out": the vault closes and every decrypted store
              goes with it. Signing out of the cloud identity alone would leave
              the local data open, which is the opposite of what the gesture
              means here. */}
          <MenuRow
            icon={<LockKeyholeIcon className="size-4" />}
            label={t("lock")}
            onClick={lockVault}
            testId="sidebar-user-lock"
          />
        </PopoverContent>
      </Popover>
      <AccountManageDialog open={manageOpen} onOpenChange={setManageOpen} />
    </>
  )
}
