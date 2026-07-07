"use client"

/**
 * Master column of the manage dialog: a searchable list of local accounts with
 * per-account avatar, status pill (active / unlocked / locked), and created
 * date, plus the collapsed create form. Presentational — the parent owns
 * selection and passes account state in.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { SearchIcon } from "lucide-react"

import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { AvatarBadge } from "@/components/desktop/avatar-badge"
import { cn } from "@/lib/utils"
import type { LocalAccountRecord } from "@/lib/accounts/account-types"

import { ACCOUNT_STATUS_LABEL_KEY, accountStatus, type AccountStatus } from "./account-status"
import { AccountCreateForm } from "./account-create-form"
import { formatAccountDate } from "./format-account-date"

export interface AccountListProps {
  accounts: LocalAccountRecord[]
  activeAccountId: string | null
  unlockedAccountId: string | null
  selectedId: string | null
  onSelect: (accountId: string) => void
  onCreated?: (account: LocalAccountRecord) => void
  error?: string | null
}

const STATUS_PILL_CLASS: Record<AccountStatus, string> = {
  active: "bg-primary/15 text-primary",
  unlocked: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  locked: "bg-muted text-muted-foreground",
}

export function AccountList({
  accounts,
  activeAccountId,
  unlockedAccountId,
  selectedId,
  onSelect,
  onCreated,
  error,
}: AccountListProps) {
  const t = useTranslations("account.manage")
  const [query, setQuery] = useState("")

  const sorted = useMemo(
    () => [...accounts].sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [accounts]
  )
  const needle = query.trim().toLowerCase()
  const filtered = needle
    ? sorted.filter((account) => account.displayName.toLowerCase().includes(needle))
    : sorted

  return (
    <div className="flex min-h-0 flex-col gap-3" data-testid="account-list">
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("searchPlaceholder")}
          aria-label={t("searchLabel")}
          className="pl-8"
          data-testid="account-list-search"
        />
      </div>

      <AccountCreateForm onCreated={onCreated} />

      {error && (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive"
        >
          {error}
        </p>
      )}

      {sorted.length === 0 ? (
        <p
          className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground"
          data-testid="account-list-empty"
        >
          {t("emptyList")}
        </p>
      ) : filtered.length === 0 ? (
        <p
          className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground"
          data-testid="account-list-no-match"
        >
          {t("noMatches")}
        </p>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <ul className="flex flex-col gap-1 pr-2" aria-label={t("listLabel")}>
            {filtered.map((account) => {
              const status = accountStatus(account.id, activeAccountId, unlockedAccountId)
              return (
                <li key={account.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(account.id)}
                    aria-current={selectedId === account.id}
                    data-testid={`account-manage-row-${account.id}`}
                    className={cn(
                      "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-accent",
                      selectedId === account.id && "bg-primary/10 text-foreground"
                    )}
                  >
                    <AvatarBadge
                      subject={{ name: account.displayName, avatarImageUrl: account.avatarDataUrl }}
                      size={28}
                    />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm">{account.displayName}</span>
                      <span className="truncate text-[10px] text-muted-foreground">
                        {t("createdAtShort", { date: formatAccountDate(account.createdAt) })}
                      </span>
                    </span>
                    <span
                      className={cn(
                        "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium",
                        STATUS_PILL_CLASS[status]
                      )}
                    >
                      {t(ACCOUNT_STATUS_LABEL_KEY[status])}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </ScrollArea>
      )}
    </div>
  )
}

export default AccountList
