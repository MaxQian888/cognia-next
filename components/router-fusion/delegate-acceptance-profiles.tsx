"use client"

/**
 * Acceptance profiles, per project, in the Router + Fusion settings
 * (ADR-0188 B4, D15, WP-D2/WP-D5).
 *
 * A delegation is accepted only on a report produced by a command the project
 * declares in `.cognia/workspace.json`, and only once a person approved that
 * exact command — the approval is bound to the command's hash, so changing the
 * command asks again. This section is where that approval is given and
 * withdrawn, and where a project that has nothing to approve says why.
 *
 * The hash shown is the hash sent: `approveAcceptanceProfile` refuses an
 * approval whose hash is no longer the profile's current one, so a command
 * that changed between the render and the click is refused instead of
 * approved unread.
 *
 * Nothing loads until the Router + Fusion master switch is on: the module that
 * reads workspace configuration and the trust store is a dynamic import behind
 * it (D36/D37).
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useProjectStore } from "@/stores/project/project-store"
import { cn } from "@/lib/utils"

/** The listing this section renders, as `acceptanceProfileAvailable` answers it. */
export interface AcceptanceProfileListingView {
  available: boolean
  profiles: readonly {
    profileId: string
    commandHash: string
    source: string
    status: string
    approvedCommandHash?: string
  }[]
  reason: string | null
  message?: string
}

export interface DelegateAcceptanceProfilesProps {
  /** The Router + Fusion master switch. Nothing is read while it is off. */
  enabled: boolean
  /** Test seams; the defaults reach the host module behind the gate. */
  listProfiles?: (projectId: string) => Promise<AcceptanceProfileListingView>
  approveProfile?: (
    projectId: string,
    profileId: string,
    commandHash: string
  ) => Promise<{ ok: boolean; code?: string; message?: string }>
  revokeProfile?: (
    projectId: string,
    profileId: string
  ) => Promise<{ ok: boolean; code?: string; message?: string }>
}

const KNOWN_STATUSES = new Set(["approved", "unapproved", "changed"])
const KNOWN_SOURCES = new Set(["repository", "project"])
const KNOWN_REASONS = new Set([
  "project_not_found",
  "absent",
  "restricted",
  "invalid",
  "approval_pending",
  "fault",
])
const KNOWN_CODES = new Set([
  "ACCEPTANCE_PROFILE_MISSING",
  "ACCEPTANCE_PROFILE_CHANGED",
  "ACCEPTANCE_PROFILE_UNTRUSTED",
  "ACCEPTANCE_PROFILE_APPROVAL_FAILED",
  "PROJECT_NOT_FOUND",
  "APPROVAL_STORE_FAILED",
])

async function defaultListProfiles(projectId: string): Promise<AcceptanceProfileListingView> {
  const { acceptanceProfileAvailable } =
    await import("@/lib/router-fusion/verify/acceptance-profiles")
  return acceptanceProfileAvailable(projectId)
}

async function defaultApproveProfile(
  projectId: string,
  profileId: string,
  commandHash: string
): Promise<{ ok: boolean; code?: string; message?: string }> {
  const { approveAcceptanceProfile } =
    await import("@/lib/router-fusion/verify/acceptance-profiles")
  return approveAcceptanceProfile(projectId, profileId, commandHash)
}

async function defaultRevokeProfile(
  projectId: string,
  profileId: string
): Promise<{ ok: boolean; code?: string; message?: string }> {
  const { revokeAcceptanceProfile } = await import("@/lib/router-fusion/verify/acceptance-profiles")
  return revokeAcceptanceProfile(projectId, profileId)
}

export function DelegateAcceptanceProfiles({
  enabled,
  listProfiles = defaultListProfiles,
  approveProfile = defaultApproveProfile,
  revokeProfile = defaultRevokeProfile,
}: DelegateAcceptanceProfilesProps) {
  const t = useTranslations("routerFusionDelegate.settings")
  const projects = useProjectStore((state) => state.projects)
  const activeProjectId = useProjectStore((state) => state.activeProjectId)
  const [projectId, setProjectId] = useState<string | null>(null)
  const [result, setResult] = useState<{
    forKey: string
    listing: AcceptanceProfileListingView
  } | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [generation, setGeneration] = useState(0)

  const selected = projectId ?? activeProjectId ?? projects[0]?.id ?? null
  const listKey = enabled && selected ? `${selected}:${generation}` : null
  // Render-derived reset: a listing tagged with a stale key reads as "loading"
  // instead of a synchronous setListing inside the effect.
  const listing = listKey !== null && result?.forKey === listKey ? result.listing : null

  useEffect(() => {
    if (listKey === null || !selected) return
    let cancelled = false
    const key = listKey
    void listProfiles(selected)
      .then((next) => {
        if (!cancelled) setResult({ forKey: key, listing: next })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setResult({
          forKey: key,
          listing: {
            available: false,
            profiles: [],
            reason: "fault",
            message: error instanceof Error ? error.message : String(error),
          },
        })
      })
    return () => {
      cancelled = true
    }
  }, [listKey, selected, listProfiles])

  const reasonText = useCallback(
    (code: string | undefined, message: string | undefined) =>
      code && KNOWN_CODES.has(code)
        ? t(`reason.${code}` as never)
        : t("reason.unknown", { code: message ?? code ?? "" }),
    [t]
  )

  const approve = async (profileId: string, commandHash: string) => {
    if (!selected) return
    setPending(profileId)
    try {
      const result = await approveProfile(selected, profileId, commandHash)
      if (result.ok) toast.success(t("approved", { profile: profileId }))
      else
        toast.error(
          t("approveFailed", {
            profile: profileId,
            reason: reasonText(result.code, result.message),
          })
        )
    } catch (error) {
      console.error("[router-fusion] acceptance profile approval failed", error)
      toast.error(
        t("approveFailed", {
          profile: profileId,
          reason: error instanceof Error ? error.message : String(error),
        })
      )
    } finally {
      setPending(null)
      setGeneration((value) => value + 1)
    }
  }

  const revoke = async (profileId: string) => {
    if (!selected) return
    setPending(profileId)
    try {
      const result = await revokeProfile(selected, profileId)
      if (result.ok) toast.success(t("revoked", { profile: profileId }))
      else
        toast.error(
          t("revokeFailed", { profile: profileId, reason: reasonText(result.code, result.message) })
        )
    } catch (error) {
      console.error("[router-fusion] acceptance profile revocation failed", error)
      toast.error(
        t("revokeFailed", {
          profile: profileId,
          reason: error instanceof Error ? error.message : String(error),
        })
      )
    } finally {
      setPending(null)
      setGeneration((value) => value + 1)
    }
  }

  return (
    <section
      className="space-y-2"
      aria-labelledby="router-fusion-acceptance-profiles"
      data-testid="router-fusion-acceptance-profiles"
    >
      <div>
        <h4 id="router-fusion-acceptance-profiles" className="text-xs font-medium">
          {t("title")}
        </h4>
        <p className="text-[11px] text-muted-foreground">{t("desc")}</p>
      </div>

      {!enabled ? (
        <p className="text-[11px] text-muted-foreground">{t("needsMaster")}</p>
      ) : projects.length === 0 || !selected ? (
        <p className="text-[11px] text-muted-foreground">{t("noProjects")}</p>
      ) : (
        <>
          <div className="space-y-1.5">
            <Label className="text-xs" htmlFor="router-fusion-acceptance-project">
              {t("project")}
            </Label>
            <Select value={selected} onValueChange={(next) => setProjectId(next)}>
              <SelectTrigger
                id="router-fusion-acceptance-project"
                className="h-8 w-60 text-xs"
                aria-label={t("project")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {projects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {listing === null ? (
            <p role="status" className="text-[11px] text-muted-foreground">
              {t("loading")}
            </p>
          ) : (
            <>
              {listing.profiles.length === 0 && listing.reason ? (
                <p
                  className="text-[11px] text-muted-foreground"
                  data-testid="router-fusion-acceptance-unavailable"
                >
                  {KNOWN_REASONS.has(listing.reason)
                    ? t(`unavailable.${listing.reason}` as never, {
                        message: listing.message ?? "",
                      })
                    : listing.reason}
                </p>
              ) : null}
              <ul className="space-y-1.5">
                {listing.profiles.map((profile) => {
                  const status = KNOWN_STATUSES.has(profile.status) ? profile.status : "unapproved"
                  const approved = status === "approved"
                  return (
                    <li
                      key={profile.profileId}
                      className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2"
                      data-testid={`router-fusion-acceptance-profile-${profile.profileId}`}
                    >
                      <div className="min-w-0 space-y-0.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-mono text-xs">{profile.profileId}</span>
                          <Badge variant="outline" className="h-4 px-1 text-[10px] font-normal">
                            {KNOWN_SOURCES.has(profile.source)
                              ? t(`source.${profile.source}` as never)
                              : profile.source}
                          </Badge>
                          <Badge
                            variant={approved ? "outline" : "secondary"}
                            className={cn(
                              "h-4 px-1 text-[10px] font-normal",
                              status === "changed" && "text-amber-600 dark:text-amber-400"
                            )}
                          >
                            {t(`status.${status}` as never)}
                          </Badge>
                        </div>
                        <p className="font-mono text-[10px] text-muted-foreground">
                          {t("hash", { hash: profile.commandHash.slice(0, 12) })}
                          {status === "changed" && profile.approvedCommandHash
                            ? ` · ${t("approvedHash", {
                                hash: profile.approvedCommandHash.slice(0, 12),
                              })}`
                            : ""}
                        </p>
                      </div>
                      <div className="flex shrink-0 gap-1.5">
                        {approved ? null : (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs"
                            disabled={pending === profile.profileId}
                            onClick={() => void approve(profile.profileId, profile.commandHash)}
                          >
                            {t("approve")}
                          </Button>
                        )}
                        {status === "unapproved" ? null : (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-7 text-xs text-destructive"
                            disabled={pending === profile.profileId}
                            onClick={() => void revoke(profile.profileId)}
                          >
                            {t("revoke")}
                          </Button>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  )
}
