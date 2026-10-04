"use client"

/**
 * One saved SSH host, collapsed to the line a list needs.
 *
 * The editor used to draw every host as its full form: eight inputs, the jump
 * host select and two forwarding tables per profile, all open at once. With
 * three hosts the list was taller than the window, and the facts a reader
 * scans for (which machine, as whom, through what, will Connect work) were
 * spread across inputs instead of being stated. This line states them; the
 * form opens under it on demand.
 *
 * "Will Connect work" is the part that matters. A password host with nothing
 * stored, a jump chain that cannot be walked, or a field that fails validation
 * each make Connect fail, and each is shown here as the reason rather than
 * discovered by clicking.
 */

import { useTranslations } from "next-intl"
import { ArrowRightIcon, KeyRoundIcon, TriangleAlertIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { resolveJumpChain } from "@/lib/terminal/ssh-forwarding"
import { validateSshHostProfile, type SshHostProfile } from "@/lib/terminal/ssh-profiles"

/** Why Connect would refuse this host, before anyone clicks it. */
export type SshHostIssue =
  | { kind: "invalid"; field: NonNullable<ReturnType<typeof validateSshHostProfile>> }
  | { kind: "chainBroken" }
  | { kind: "passwordMissing" }

export function sshHostIssue(
  profile: SshHostProfile,
  all: readonly SshHostProfile[]
): SshHostIssue | null {
  const field = validateSshHostProfile(profile)
  if (field) return { kind: "invalid", field }
  if (profile.jumpHostId && !resolveJumpChain(profile, all)) return { kind: "chainBroken" }
  if (profile.authMethod === "password" && !profile.credentialRef) {
    return { kind: "passwordMissing" }
  }
  return null
}

/** `user@host` with the port only when it is not 22, the way people write it. */
export function sshAddress(profile: Pick<SshHostProfile, "username" | "host" | "port">): string {
  const user = profile.username.trim()
  const host = profile.host.trim()
  const base = user ? `${user}@${host}` : host
  return profile.port === 22 ? base : `${base}:${profile.port}`
}

export interface SshHostSummaryProps {
  profile: SshHostProfile
  allProfiles: readonly SshHostProfile[]
}

export function SshHostSummary({ profile, allProfiles }: SshHostSummaryProps) {
  const t = useTranslations("settings.terminal.ssh.summary")
  const issue = sshHostIssue(profile, allProfiles)
  const chain = issue?.kind === "chainBroken" ? null : resolveJumpChain(profile, allProfiles)
  const bastions = chain ? chain.slice(0, -1) : []
  const forwards =
    (profile.localForwards ?? []).filter((rule) => rule.enabled).length +
    (profile.remoteForwards ?? []).filter((rule) => rule.enabled).length
  const address = sshAddress(profile)

  return (
    <span className="flex min-w-0 flex-1 flex-col gap-1 text-left" data-testid="ssh-host-summary">
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate text-xs font-medium">{profile.name.trim() || t("untitled")}</span>
        {address ? (
          <span className="truncate font-mono text-[11px] text-muted-foreground">{address}</span>
        ) : null}
      </span>
      <span className="flex flex-wrap items-center gap-1">
        <Badge variant="outline" className="gap-1 px-1.5 py-0 text-[10px] font-normal">
          <KeyRoundIcon className="size-2.5" aria-hidden />
          {t(`auth.${profile.authMethod}`)}
        </Badge>
        {bastions.length > 0 ? (
          <Badge
            variant="outline"
            className="gap-1 px-1.5 py-0 text-[10px] font-normal"
            data-testid="ssh-host-summary-via"
          >
            <ArrowRightIcon className="size-2.5" aria-hidden />
            {t("via", { names: bastions.map((hop) => hop.name.trim() || hop.host).join(" → ") })}
          </Badge>
        ) : null}
        {forwards > 0 ? (
          <Badge
            variant="outline"
            className="px-1.5 py-0 text-[10px] font-normal"
            data-testid="ssh-host-summary-forwards"
          >
            {t("forwards", { count: forwards })}
          </Badge>
        ) : null}
        {issue ? (
          <span
            className="flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-500"
            data-testid="ssh-host-summary-issue"
            data-issue={issue.kind}
          >
            <TriangleAlertIcon className="size-3" aria-hidden />
            {issue.kind === "invalid"
              ? t(`issue.invalid.${issue.field}`)
              : t(`issue.${issue.kind}`)}
          </span>
        ) : null}
      </span>
    </span>
  )
}
