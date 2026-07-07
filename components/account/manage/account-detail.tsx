"use client"

/**
 * Detail pane of the manage dialog: an identity header with an inline
 * switch/unlock action (shared `useAccountSwitch` flow) over three sub-tabs —
 * Profile / Security / Danger zone. The tab bodies are keyed by `account.id` so
 * their drafts reset when the selection changes. On narrow layouts the parent
 * passes `showBack`; the back button hides itself at the `@lg` container width.
 */

import { useTranslations } from "next-intl"
import { ArrowLeftIcon, CheckIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { AvatarBadge } from "@/components/desktop/avatar-badge"
import type { LocalAccountRecord } from "@/lib/accounts/account-types"

import { ACCOUNT_STATUS_LABEL_KEY, accountStatus } from "./account-status"
import { useAccountSwitch } from "./use-account-switch"
import { AccountProfileTab } from "./account-profile-tab"
import { AccountSecurityTab } from "./account-security-tab"
import { AccountDangerTab } from "./account-danger-tab"

export interface AccountDetailProps {
  account: LocalAccountRecord | null
  accounts: LocalAccountRecord[]
  activeAccountId: string | null
  unlockedAccountId: string | null
  onBack?: () => void
  showBack?: boolean
}

export function AccountDetail({
  account,
  accounts,
  activeAccountId,
  unlockedAccountId,
  onBack,
  showBack,
}: AccountDetailProps) {
  const t = useTranslations("account.manage")
  const switcher = useAccountSwitch({ operationFailedLabel: t("operationFailed") })

  if (!account) {
    return (
      <div
        className="flex h-full min-h-40 items-center justify-center rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground"
        data-testid="account-detail-empty"
      >
        {t("empty")}
      </div>
    )
  }

  const status = accountStatus(account.id, activeAccountId, unlockedAccountId)
  const isActive = status === "active"
  const promptingHere = switcher.pendingId === account.id

  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="account-detail">
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          {showBack ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 shrink-0 @lg:hidden"
              onClick={onBack}
              aria-label={t("back")}
              data-testid="account-detail-back"
            >
              <ArrowLeftIcon className="size-4" />
            </Button>
          ) : null}
          <AvatarBadge
            subject={{ name: account.displayName, avatarImageUrl: account.avatarDataUrl }}
            size={36}
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{account.displayName}</p>
            <p className="text-[11px] text-muted-foreground">
              {t(ACCOUNT_STATUS_LABEL_KEY[status])}
            </p>
          </div>
          {isActive ? (
            <span
              className="flex shrink-0 items-center gap-1 text-xs text-primary"
              data-testid="account-detail-active"
            >
              <CheckIcon className="size-4" />
              {t("activeAccountLabel")}
            </span>
          ) : !promptingHere ? (
            <Button
              type="button"
              size="sm"
              className="shrink-0"
              onClick={() => void switcher.begin(account.id)}
              data-testid="account-detail-switch"
            >
              {t("switchToAccount")}
            </Button>
          ) : null}
        </div>

        {promptingHere ? (
          <form
            className="flex flex-col gap-2 rounded-md border p-3"
            aria-label={t("switchToAccount")}
            onSubmit={(event) => {
              event.preventDefault()
              void switcher.confirm()
            }}
          >
            <Label htmlFor="account-switch-password">{t("switchPasswordLabel")}</Label>
            <Input
              id="account-switch-password"
              type="password"
              autoComplete="current-password"
              value={switcher.password}
              placeholder={t("switchPasswordPlaceholder")}
              onChange={(event) => switcher.setPassword(event.target.value)}
            />
            {switcher.error ? (
              <p role="alert" className="text-sm text-destructive">
                {switcher.error}
              </p>
            ) : null}
            <div className="flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={switcher.cancel}
                disabled={switcher.submitting}
              >
                {t("cancel")}
              </Button>
              <Button type="submit" size="sm" disabled={switcher.submitting}>
                {t("confirmSwitch")}
              </Button>
            </div>
          </form>
        ) : null}
      </div>

      <Tabs defaultValue="profile" className="min-w-0">
        <TabsList className="w-full">
          <TabsTrigger value="profile" data-testid="account-tab-profile">
            {t("tabProfile")}
          </TabsTrigger>
          <TabsTrigger value="security" data-testid="account-tab-security">
            {t("tabSecurity")}
          </TabsTrigger>
          <TabsTrigger value="danger" data-testid="account-tab-danger">
            {t("tabDanger")}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="profile" className="mt-4">
          <AccountProfileTab key={account.id} account={account} />
        </TabsContent>
        <TabsContent value="security" className="mt-4">
          <AccountSecurityTab key={account.id} account={account} />
        </TabsContent>
        <TabsContent value="danger" className="mt-4">
          <AccountDangerTab
            key={account.id}
            account={account}
            accounts={accounts}
            activeAccountId={activeAccountId}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}

export default AccountDetail
