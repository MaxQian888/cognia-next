"use client"

/**
 * The credential slots this Bot declares, and what each is bound to.
 *
 * Never a secret, and not even a value: a binding is an integration account id
 * or a connector adapter id, and the broker resolves the actual credential at
 * call time without the Bot, its handler or this pane ever seeing it.
 *
 * An unbound REQUIRED slot is the reason an installation reads `needs_setup`,
 * so the row that causes the status is shown beside the status rather than
 * leaving the user to guess which one it was. An unbound OPTIONAL slot is
 * listed and not flagged: the Bot runs fine without it, and marking it would
 * put a permanent amber dot on a working installation.
 */

import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import type { BotConsoleRow, BotCredentialRow } from "@/lib/bot/console/bot-rows"
import { cn } from "@/lib/utils"

function CredentialItem({ credential }: { credential: BotCredentialRow }) {
  const t = useTranslations("bots")
  const needsBinding = !credential.bound && !credential.optional

  // What it points at, when it points at anything. An id rather than a name:
  // resolving one would need the integration registry and an account read on a
  // pane that is otherwise two Dexie rows, and the id is what a person
  // checking they picked the right account actually compares.
  const target = credential.integrationAccountId ?? credential.adapterId

  return (
    <li
      className="flex items-start gap-2.5 py-2 first:pt-0 last:pb-0"
      data-testid={`bot-credential-${credential.id}`}
      data-bound={credential.bound ? "true" : "false"}
    >
      <span
        aria-hidden
        className={cn(
          "mt-1.5 size-1.5 shrink-0 rounded-full",
          credential.bound
            ? "bg-emerald-500"
            : needsBinding
              ? "bg-amber-500"
              : "bg-muted-foreground/40"
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 truncate text-xs font-medium">{credential.label}</span>
          {credential.optional ? (
            <Badge variant="outline" className="shrink-0 font-normal text-muted-foreground">
              {t("credentials.optional")}
            </Badge>
          ) : null}
          {needsBinding ? (
            <Badge
              variant="outline"
              className="shrink-0 font-normal text-amber-600 dark:text-amber-400"
            >
              {t("credentials.unbound")}
            </Badge>
          ) : null}
        </div>
        <p className="mt-0.5 break-all text-[11px] leading-snug text-muted-foreground">
          {target ? t("credentials.boundTo", { target }) : t("credentials.notBound")}
          {credential.integration ? ` · ${credential.integration}` : ""}
        </p>
      </div>
    </li>
  )
}

export function BotCredentialsSection({ row }: { row: BotConsoleRow }) {
  const t = useTranslations("bots")

  if (row.credentials.length === 0) {
    return (
      <Empty className="border-none py-4">
        <EmptyHeader>
          <EmptyTitle className="text-sm">
            {row.orphaned ? t("credentials.orphanTitle") : t("credentials.emptyTitle")}
          </EmptyTitle>
          <EmptyDescription className="text-xs">
            {row.orphaned ? t("credentials.orphanBody") : t("credentials.emptyBody")}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <ul className="divide-y" data-testid="bot-credentials">
      {row.credentials.map((credential) => (
        <CredentialItem key={credential.id} credential={credential} />
      ))}
    </ul>
  )
}
