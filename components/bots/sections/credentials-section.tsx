"use client"

/**
 * The credential slots this Bot declares, what each is bound to, and the
 * picker that binds them.
 *
 * Never a secret, and not even a value: a binding is an integration account id
 * or a connector adapter id, and the broker resolves the actual credential at
 * call time without the Bot, its handler or this pane ever seeing it. An auth
 * session is deliberately not offered as a choice of its own, because a
 * session is a property of an account and a binding naming one without an
 * account is a pair the broker cannot resolve.
 *
 * An unbound REQUIRED slot is the reason an installation reads `needs_setup`,
 * so the row that causes the status is shown beside the status rather than
 * leaving the user to guess which one it was. An unbound OPTIONAL slot is
 * listed and not flagged: the Bot runs fine without it, and marking it would
 * put a permanent amber dot on a working installation.
 *
 * The picker is rendered and DISABLED when this shell cannot write, with the
 * reason underneath. Hiding it would collapse "this Bot needs no credentials",
 * "you cannot bind from here" and "it is bound already" into one blank space.
 */

import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  useBotLifecycleActions,
  useBotLifecycleReadiness,
} from "@/hooks/bots/use-bot-lifecycle-actions"
import { useCredentialCandidates } from "@/hooks/bots/use-credential-candidates"
import type { BotConsoleRow, BotCredentialRow } from "@/lib/bot/console/bot-rows"
import {
  credentialSourceForSlot,
  selectedCandidateValue,
  type BotCredentialCandidate,
} from "@/lib/bot/console/credential-candidates"
import { cn } from "@/lib/utils"

/** The sentinel a Select uses for "none", since Radix refuses an empty value. */
const UNBOUND_VALUE = "__unbound__"

interface CredentialItemProps {
  credential: BotCredentialRow
  candidates: readonly BotCredentialCandidate[]
  canBind: boolean
  busy: boolean
  onBind: (candidate: BotCredentialCandidate | null) => void
}

function CredentialItem({ credential, candidates, canBind, busy, onBind }: CredentialItemProps) {
  const t = useTranslations("bots")
  const needsBinding = !credential.bound && !credential.optional

  // What it points at, when it points at anything. An id rather than a name:
  // resolving one would need the integration registry and an account read on a
  // pane that is otherwise two Dexie rows, and the id is what a person
  // checking they picked the right account actually compares.
  const target = credential.integrationAccountId ?? credential.adapterId
  const selected = selectedCandidateValue(credential)
  const source = credentialSourceForSlot(
    credential.integration ? { integration: credential.integration } : {},
    candidates.filter((c) => c.kind === "adapter").map((c) => c.detail ?? "")
  )

  return (
    <li
      className="flex items-start gap-2.5 py-2.5 first:pt-0 last:pb-0"
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

        {candidates.length === 0 ? (
          // Nothing to pick is a different problem from not being allowed to
          // pick, and the remedy differs per source: connect an account, or
          // add a connector.
          <p
            className="mt-1 text-[11px] leading-snug text-muted-foreground"
            data-testid={`bot-credential-empty-${credential.id}`}
          >
            {t(`credentials.noCandidates.${source}`)}
          </p>
        ) : (
          <Select
            value={selected ?? UNBOUND_VALUE}
            disabled={!canBind || busy}
            onValueChange={(next) =>
              onBind(
                next === UNBOUND_VALUE
                  ? null
                  : (candidates.find((candidate) => candidate.value === next) ?? null)
              )
            }
          >
            <SelectTrigger
              className="mt-1 h-8 text-xs"
              aria-label={t("credentials.bindAria", { slot: credential.label })}
              data-testid={`bot-credential-select-${credential.id}`}
            >
              <SelectValue placeholder={t("credentials.choosePlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={UNBOUND_VALUE}>{t("credentials.clear")}</SelectItem>
              {candidates.map((candidate) => (
                <SelectItem key={candidate.value} value={candidate.value}>
                  {/* One string, not nested elements: a Radix item derives its
                      accessible label from its children, and an element child
                      leaves the option unlabelled. */}
                  {candidate.disabled
                    ? t("credentials.candidateDisabled", {
                        label: candidate.label,
                        detail: candidate.detail ?? "",
                      })
                    : t("credentials.candidate", {
                        label: candidate.label,
                        detail: candidate.detail ?? "",
                      })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <p className="mt-1 break-all text-[11px] leading-snug text-muted-foreground">
          {target ? t("credentials.boundTo", { target }) : t("credentials.notBound")}
          {credential.integration ? ` · ${credential.integration}` : ""}
        </p>
      </div>
    </li>
  )
}

export function BotCredentialsSection({ row }: { row: BotConsoleRow }) {
  const t = useTranslations("bots")
  const readiness = useBotLifecycleReadiness()
  const actions = useBotLifecycleActions()
  const { forSlot } = useCredentialCandidates()

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

  // An orphan has no definition to validate a slot against, and the write
  // refuses one outright rather than let `updateBotInstallation` re-derive a
  // status against a requirement list nobody can read.
  const canBind = readiness.can && !row.orphaned

  return (
    <div className="flex flex-col gap-2">
      <ul className="divide-y" data-testid="bot-credentials">
        {row.credentials.map((credential) => (
          <CredentialItem
            key={credential.id}
            credential={credential}
            candidates={forSlot({
              id: credential.id,
              ...(credential.integration ? { integration: credential.integration } : {}),
            })}
            canBind={canBind}
            busy={actions.pending.has(`credential:${credential.id}`)}
            onBind={(candidate) => void actions.bindCredential(row.id, credential.id, candidate)}
          />
        ))}
      </ul>
      {!canBind ? (
        <p
          className="text-[11px] leading-snug text-muted-foreground"
          data-testid="bot-credentials-blocked"
        >
          {row.orphaned
            ? t("credentials.blockedOrphan")
            : t(`write.reason.${readiness.availability.reason}`)}
        </p>
      ) : null}
    </div>
  )
}
