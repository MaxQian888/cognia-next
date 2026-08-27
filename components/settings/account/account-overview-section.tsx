"use client"

/**
 * Desktop account overview — the unified identity surface desktop users get
 * in place of the mobile `/me` hub (the desktop `/me` route redirects here,
 * and `?section=profile` now redirects here too).
 *
 * This is the aggregation surface: a credential-only "plan & session" block
 * (plan, email, usage, session lifecycle), the embedded profile EDITOR
 * (`<ProfileSection />` — the single owner of avatar/name/pronouns/status/bio/
 * timezone, so those fields render exactly once), local-account management +
 * quick-switch, and jump-offs to the subscription, security, and
 * companion-devices sections.
 *
 * Layout: a flat `SettingsStack`, not a stack of cards. Every group here is
 * three or four lines of read-only summary plus one button — a `<Card>` per
 * group turned the page into six floating boxes with more chrome than content,
 * and boxed the embedded profile editor inside a second border.
 *
 * Reuses the same neutral hooks the mobile AccountCard sits on — but NOT the
 * mobile-coupled AccountCard component itself (it hard-links into `/me/*`).
 * Sign-out / refresh reuse the SAME `useActiveAnthropicCredential()` the
 * subscription Account tab drives (one implementation), and reuse its
 * `subscription.account.*` labels rather than minting parallel keys.
 *
 * `now` is sourced from a ticking state (never `Date.now()` in render) so the
 * usage reset countdown stays accurate without a purity violation, and the
 * server + first client render agree (matches the `desktopReady` pattern).
 */

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  CopyIcon,
  KeyRoundIcon,
  LinkIcon,
  LockIcon,
  LogOutIcon,
  PlugZapIcon,
  RefreshCwIcon,
  UsersRoundIcon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { AccountManageDialog } from "@/components/account/account-manage-dialog"
import {
  SettingsBlock,
  SettingsField,
  SettingsStack,
} from "@/components/settings/common/settings-block"
import { isTauri } from "@/lib/tauri"
import { writeClipboardText } from "@/lib/tauri/clipboard"
import { useActiveAnthropicCredential, useAnthropicUsage } from "@/lib/subscription/anthropic/hooks"
import { useCompanionConfig } from "@/hooks/companion/use-companion-config"
import { selectActiveAccount, useAccountStore } from "@/stores/account/account-store"
import { useSettingsStore } from "@/stores/settings"

import { ProfileSection } from "../profile/profile-section"

/** Format the time until `resetAt` relative to `now`. `now === 0` (pre-mount) → null. */
function formatResetAt(resetAt: number | undefined, now: number): string | null {
  if (!resetAt || now === 0) return null
  const delta = resetAt - now
  if (delta <= 0) return null
  const hours = Math.floor(delta / 3_600_000)
  const minutes = Math.floor((delta % 3_600_000) / 60_000)
  if (hours >= 24) return `${Math.floor(hours / 24)}d`
  if (hours >= 1) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

function UsageRow({
  label,
  utilization,
  resetAt,
  resetLabel,
  now,
}: {
  label: string
  utilization: number | null
  resetAt: number | undefined
  resetLabel: string
  now: number
}) {
  if (utilization === null) return null
  const pct = Math.round(Math.max(0, Math.min(1, utilization)) * 100)
  const reset = formatResetAt(resetAt, now)
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-[11px]">
        <span className="font-medium">{label}</span>
        <span className="text-muted-foreground">
          {pct}%{reset ? ` · ${resetLabel.replace("{remaining}", reset)}` : ""}
        </span>
      </div>
      <Progress value={pct} className="h-1.5" aria-label={label} />
    </div>
  )
}

export function AccountOverviewSection() {
  const t = useTranslations("settings.account")
  const tSub = useTranslations("subscription")
  const router = useRouter()
  const { credential, refresh, signOut } = useActiveAnthropicCredential()
  const { latest } = useAnthropicUsage(1)
  const { paired, shortDeviceId } = useCompanionConfig()
  const accounts = useAccountStore((state) => state.accounts)
  const activeAccount = useAccountStore(selectActiveAccount)
  const unlockedAccountId = useAccountStore((state) => state.unlockedAccountId)
  const lockAccounts = useAccountStore((state) => state.lock)
  const switchAccount = useAccountStore((state) => state.switchAccount)
  const autoLockMinutes = useSettingsStore((state) => state.settings?.accountAutoLockMinutes ?? 0)
  const [manageOpen, setManageOpen] = useState(false)
  const [busy, setBusy] = useState<"refresh" | "signOut" | null>(null)
  // Local accounts are a Tauri-only concept; resolve post-hydration to keep the
  // server + first client render in agreement (mirrors settings-sidebar.tsx).
  const [desktopReady, setDesktopReady] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setDesktopReady(isTauri()), 0)
    return () => clearTimeout(timer)
  }, [])
  // Ticking clock for the usage countdown — set post-mount, refreshed each
  // minute. Kept out of render so there's no `Date.now()` purity violation;
  // the initial write is deferred into a timer (never a synchronous setState
  // in the effect body) to match the `desktopReady` pattern above.
  const [now, setNow] = useState(0)
  useEffect(() => {
    const update = () => setNow(Date.now())
    const initial = setTimeout(update, 0)
    const interval = setInterval(update, 60_000)
    return () => {
      clearTimeout(initial)
      clearInterval(interval)
    }
  }, [])

  const accountCount = accounts.length
  const email = credential?.email ?? ""
  const planLabel = credential?.plan ? credential.plan.toUpperCase() : t("fallbackPlan")
  const expiry = credential ? new Date(credential.expiresAtMs).toLocaleString() : null
  const fiveHour = latest?.fiveHour ?? null
  const sevenDay = latest?.sevenDay ?? null

  const copyEmail = async () => {
    if (!email) return
    try {
      await writeClipboardText(email)
      toast.success(t("emailCopied"))
    } catch {
      toast.error(t("emailCopyFailed"))
    }
  }

  const onRefresh = async () => {
    setBusy("refresh")
    try {
      await refresh()
      toast.success(t("sessionRefreshed"))
    } catch {
      toast.error(t("sessionActionFailed"))
    } finally {
      setBusy(null)
    }
  }

  const onSignOut = async () => {
    setBusy("signOut")
    try {
      await signOut()
      toast.success(t("signedOut"))
    } catch {
      toast.error(t("sessionActionFailed"))
    } finally {
      setBusy(null)
    }
  }

  const lockNow = async () => {
    // `lock()` is async and can reject on a partial teardown. Firing it bare and
    // toasting success unconditionally reported "locked" for a lock that had
    // failed, and left an unhandled rejection behind. The account still ends up
    // locked either way — the store commits that unconditionally — so the toast
    // reflects whether the teardown was clean.
    try {
      await lockAccounts()
      toast.success(t("lockedNow"))
    } catch {
      toast.error(t("lockIncomplete"))
    }
  }

  // Switching to a password-protected account can't happen inline — route the
  // user to the manage dialog's unlock flow instead of building a new one.
  const handleSwitch = async (accountId: string) => {
    if (accountId === activeAccount?.id) return
    try {
      await switchAccount(accountId)
    } catch {
      toast.error(t("switchAccountRequiresUnlock"))
      setManageOpen(true)
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-5" data-testid="account-overview-section">
      <div className="min-w-0 space-y-1">
        <h2 className="text-base font-semibold tracking-tight">{t("title")}</h2>
        <p className="text-xs text-pretty text-muted-foreground">{t("description")}</p>
      </div>

      <SettingsStack>
        {/* ── Plan & session ─────────────────────────────────────────────── */}
        <SettingsBlock
          icon={<KeyRoundIcon />}
          title={t("sessionTitle")}
          description={t("sessionDescription")}
          testid="account-session-block"
          action={
            credential ? (
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => void onRefresh()}
                  disabled={busy !== null}
                  data-testid="account-overview-refresh"
                >
                  <RefreshCwIcon
                    className={`size-3.5 ${busy === "refresh" ? "animate-spin" : ""}`}
                  />
                  {tSub("account.refresh")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => void onSignOut()}
                  disabled={busy !== null}
                  data-testid="account-overview-signout"
                >
                  <LogOutIcon className="size-3.5" />
                  {tSub("account.signOut")}
                </Button>
              </div>
            ) : null
          }
        >
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
            <Badge variant="outline" className="text-[10px]" data-testid="account-overview-plan">
              {planLabel}
            </Badge>
            {credential && expiry ? (
              <span
                className="text-[11px] text-muted-foreground"
                data-testid="account-overview-expiry"
              >
                {tSub("account.expiresLabel")}: {expiry}
              </span>
            ) : null}
            {email ? (
              <span className="flex min-w-0 items-center gap-1">
                <span
                  className="truncate text-xs text-muted-foreground"
                  data-testid="account-overview-email"
                >
                  {email}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-5 shrink-0 text-muted-foreground"
                  onClick={() => void copyEmail()}
                  aria-label={t("emailCopyAria")}
                  data-testid="account-overview-copy-email"
                >
                  <CopyIcon className="size-3" />
                </Button>
              </span>
            ) : (
              <span className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">{t("notSignedIn")}</span>
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto gap-1 p-0 text-xs"
                  onClick={() => router.push("/settings?section=subscription")}
                  data-testid="account-overview-connect"
                >
                  <PlugZapIcon className="size-3" />
                  {t("connect")}
                </Button>
              </span>
            )}
          </div>
          {fiveHour || sevenDay ? (
            <div className="flex flex-col gap-2 border-t border-border/50 pt-3">
              <UsageRow
                label={t("usageFiveHour")}
                utilization={fiveHour?.utilization ?? null}
                resetAt={fiveHour?.resetAt}
                resetLabel={t("usageReset")}
                now={now}
              />
              <UsageRow
                label={t("usageSevenDay")}
                utilization={sevenDay?.utilization ?? null}
                resetAt={sevenDay?.resetAt}
                resetLabel={t("usageReset")}
                now={now}
              />
            </div>
          ) : null}
        </SettingsBlock>

        {/* ── Local accounts (desktop only) ──────────────────────────────── */}
        {desktopReady ? (
          <SettingsBlock
            icon={<UsersRoundIcon />}
            title={t("localAccountsTitle")}
            testid="account-local-block"
            action={
              <div className="flex items-center gap-2">
                {unlockedAccountId ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="gap-1.5"
                    onClick={() => void lockNow()}
                    data-testid="account-overview-lock-now"
                  >
                    <LockIcon className="size-3.5" />
                    {t("lockNow")}
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setManageOpen(true)}
                  data-testid="account-overview-manage-local"
                >
                  {t("localAccountsManage")}
                </Button>
              </div>
            }
          >
            <p
              className="text-xs text-muted-foreground"
              data-testid="account-overview-local-summary"
            >
              {t("localAccountsSummary", {
                name: activeAccount?.displayName ?? t("fallbackName"),
                count: accountCount,
              })}
            </p>
            {accounts.length > 1 ? (
              <SettingsField label={t("switchAccountAria")} stacked>
                <Select value={activeAccount?.id ?? undefined} onValueChange={handleSwitch}>
                  <SelectTrigger
                    className="w-full"
                    aria-label={t("switchAccountAria")}
                    data-testid="account-overview-switch"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {accounts.map((account) => (
                      <SelectItem key={account.id} value={account.id}>
                        {account.displayName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingsField>
            ) : null}
          </SettingsBlock>
        ) : null}

        {/* ── Profile editor ─────────────────────────────────────────────── */}
        <ProfileSection showEmail={false} />

        {/* ── Jump-offs to the sections that own these settings ──────────── */}
        <SettingsBlock
          icon={<LinkIcon />}
          title={t("manageTitle")}
          description={t("manageDescription")}
          testid="account-links-block"
          contentClassName="space-y-0 [&>*+*]:pt-4"
        >
          <SettingsField label={t("subscriptionTitle")} description={planLabel}>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => router.push("/settings?section=subscription")}
              data-testid="account-overview-manage-subscription"
            >
              {t("subscriptionManage")}
            </Button>
          </SettingsField>

          {desktopReady ? (
            <SettingsField
              label={t("securityTitle")}
              description={
                autoLockMinutes > 0
                  ? t("securityAutoLockOn", { minutes: autoLockMinutes })
                  : t("securityAutoLockOff")
              }
              testid="account-overview-security-summary"
            >
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => router.push("/settings?section=security")}
                data-testid="account-overview-manage-security"
              >
                {t("securityManage")}
              </Button>
            </SettingsField>
          ) : null}

          <SettingsField
            label={t("devicesTitle")}
            description={
              paired && shortDeviceId
                ? t("devicePaired", { id: shortDeviceId })
                : t("deviceUnpaired")
            }
          >
            {paired ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => router.push("/settings?section=companion")}
                data-testid="account-overview-manage-devices"
              >
                {t("devicesManage")}
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => router.push("/pair")}
                data-testid="account-overview-pair"
              >
                {t("pair")}
              </Button>
            )}
          </SettingsField>
        </SettingsBlock>
      </SettingsStack>

      {desktopReady ? <AccountManageDialog open={manageOpen} onOpenChange={setManageOpen} /> : null}
    </div>
  )
}
