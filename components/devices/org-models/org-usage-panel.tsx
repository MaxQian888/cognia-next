"use client"

/**
 * Org model spend and monthly caps, for an owner or admin (P6g, plan §9b.6).
 *
 * The Host meters every member turn through the org key against that
 * member's monthly token cap: the org default, or the person's own cap. A turn
 * that would pass it is refused before any provider call
 * (`member_usage_cap_reached`). This panel shows the month's spend per person
 * and edits both caps. People are named by their organization user id; the
 * Host has no display names to give.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { useFormatter, useTranslations } from "next-intl"
import { toast } from "sonner"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  getOrgUsage,
  MAX_ORG_MONTHLY_TOKENS,
  setOrgDefaultCap,
  setOrgMemberCap,
  type OrgMemberUsage,
  type OrgUsageReport,
} from "@/lib/remote-host/org-models"

export interface OrgUsagePanelDeps {
  getUsage?: (hostRef: string) => Promise<OrgUsageReport>
  setDefaultCap?: (hostRef: string, monthlyTokens: number | null) => Promise<void>
  setMemberCap?: (
    hostRef: string,
    userId: string,
    monthlyTokens: number | null | "default"
  ) => Promise<void>
}

/** A whole token count the Host accepts, or `null` when the text is not one. */
export function parseCapTokens(text: string): number | null {
  const trimmed = text.trim().replace(/[,_\s]/g, "")
  if (!/^\d+$/.test(trimmed)) return null
  const value = Number(trimmed)
  return Number.isSafeInteger(value) && value <= MAX_ORG_MONTHLY_TOKENS ? value : null
}

type CapMode = "limit" | "unlimited" | "default"

interface CapDraft {
  mode: CapMode
  text: string
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function OrgUsagePanel({
  hostRef,
  host,
  deps = {},
}: {
  hostRef: string
  host: string
  deps?: OrgUsagePanelDeps
}) {
  const t = useTranslations("devices.orgModels.usage")
  const format = useFormatter()
  const getUsage = deps.getUsage ?? getOrgUsage
  const writeDefault = deps.setDefaultCap ?? setOrgDefaultCap
  const writeMember = deps.setMemberCap ?? setOrgMemberCap

  const [report, setReport] = useState<OrgUsageReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [defaultDraft, setDefaultDraft] = useState<CapDraft | null>(null)
  const [editing, setEditing] = useState<{
    userId: string
    name: string
    draft: CapDraft
  } | null>(null)
  const generation = useRef(0)

  const reload = useCallback(async () => {
    const ticket = ++generation.current
    try {
      const next = await getUsage(hostRef)
      if (ticket !== generation.current) return
      setReport(next)
      setError(null)
    } catch (cause) {
      if (ticket !== generation.current) return
      setError(message(cause))
    }
  }, [getUsage, hostRef])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the read on mount; its results land after the await
    void reload()
  }, [reload])

  const tokens = (value: number) => format.number(value, { notation: "compact" })

  const act = async (key: string, run: () => Promise<void>) => {
    setBusy(key)
    try {
      await run()
    } catch (cause) {
      toast.error(message(cause))
    } finally {
      setBusy(null)
      await reload()
    }
  }

  const draftCap = (draft: CapDraft): number | null | "default" | undefined =>
    draft.mode === "default"
      ? "default"
      : draft.mode === "unlimited"
        ? null
        : (parseCapTokens(draft.text) ?? undefined)

  const saveDefault = () => {
    if (!defaultDraft) return
    const cap = draftCap(defaultDraft)
    if (cap === undefined || cap === "default") return
    return act("default", async () => {
      await writeDefault(hostRef, cap)
      setDefaultDraft(null)
      toast.success(t("defaultSaved", { host }))
    })
  }

  const saveMember = () => {
    if (!editing) return
    const cap = draftCap(editing.draft)
    if (cap === undefined) return
    const { userId, name } = editing
    return act(`member:${userId}`, async () => {
      await writeMember(hostRef, userId, cap)
      setEditing(null)
      toast.success(t("memberSaved", { user: name }))
    })
  }

  const capLabel = (monthlyTokens: number | null) =>
    monthlyTokens === null ? t("noLimit") : t("tokens", { count: tokens(monthlyTokens) })

  const editor = (
    draft: CapDraft,
    change: (next: CapDraft) => void,
    allowDefault: boolean,
    id: string
  ) => (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        value={draft.mode}
        onValueChange={(mode) => change({ ...draft, mode: mode as CapMode })}
      >
        <SelectTrigger className="h-8 w-40" data-testid={`${id}-mode`} aria-label={t("capMode")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {allowDefault ? <SelectItem value="default">{t("mode.default")}</SelectItem> : null}
          <SelectItem value="limit">{t("mode.limit")}</SelectItem>
          <SelectItem value="unlimited">{t("mode.unlimited")}</SelectItem>
        </SelectContent>
      </Select>
      {draft.mode === "limit" ? (
        <Input
          className="h-8 w-36"
          inputMode="numeric"
          value={draft.text}
          onChange={(event) => change({ ...draft, text: event.target.value })}
          aria-label={t("capTokens")}
          aria-invalid={draft.text.length > 0 && parseCapTokens(draft.text) === null}
          data-testid={`${id}-tokens`}
        />
      ) : null}
    </div>
  )

  const memberRow = (member: OrgMemberUsage) => {
    const cap = member.monthlyTokens
    const used = member.spentTokens + member.reservedTokens
    const percent =
      cap === null || cap === 0 ? (cap === 0 ? 100 : 0) : Math.min(100, (used / cap) * 100)
    const isEditing = editing?.userId === member.userId
    const capReached = cap !== null && used >= cap
    return (
      <li
        key={member.userId}
        className="space-y-1.5 rounded-md border px-2.5 py-2 text-sm"
        data-testid={`org-usage-member-${member.userId}`}
      >
        <div className="flex flex-wrap items-center gap-2">
          {member.displayName ? (
            <span className="flex min-w-0 flex-1 flex-col">
              <span
                className="truncate font-medium"
                data-testid={`org-usage-name-${member.userId}`}
              >
                {member.displayName}
              </span>
              <code className="text-muted-foreground font-mono text-xs break-all">
                {member.userId}
              </code>
            </span>
          ) : (
            <code className="min-w-0 flex-1 font-mono text-xs break-all">{member.userId}</code>
          )}
          <Badge variant="outline" className="text-xs">
            {member.capSource === "override" ? t("source.override") : t("source.default")}
          </Badge>
          {capReached ? (
            <Badge
              variant="destructive"
              className="text-xs"
              data-testid={`org-usage-capped-${member.userId}`}
            >
              {t("capReached")}
            </Badge>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            disabled={busy !== null}
            onClick={() =>
              setEditing(
                isEditing
                  ? null
                  : {
                      userId: member.userId,
                      name: member.displayName ?? member.userId,
                      draft: {
                        mode:
                          member.capSource === "default"
                            ? "default"
                            : cap === null
                              ? "unlimited"
                              : "limit",
                        text: cap === null ? "" : String(cap),
                      },
                    }
              )
            }
            data-testid={`org-usage-edit-${member.userId}`}
          >
            {isEditing ? t("cancel") : t("edit")}
          </Button>
        </div>
        <Progress
          value={percent}
          className="h-1.5"
          aria-label={t("spentAria", { user: member.userId })}
        />
        <p
          className="text-xs text-muted-foreground"
          data-testid={`org-usage-spent-${member.userId}`}
        >
          {t("spent", { spent: tokens(member.spentTokens), cap: capLabel(cap) })}
          {member.reservedTokens > 0
            ? ` · ${t("reserved", { count: tokens(member.reservedTokens) })}`
            : ""}
        </p>
        {isEditing && editing ? (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {editor(
              editing.draft,
              (draft) => setEditing((current) => current && { ...current, draft }),
              true,
              `org-usage-member-cap-${member.userId}`
            )}
            <Button
              size="sm"
              disabled={busy !== null || draftCap(editing.draft) === undefined}
              onClick={() => void saveMember()}
              data-testid={`org-usage-member-save-${member.userId}`}
            >
              {busy === `member:${member.userId}` ? t("saving") : t("save")}
            </Button>
          </div>
        ) : null}
      </li>
    )
  }

  const defaultCap = report?.defaultMonthlyTokens ?? null
  const shownDefault: CapDraft = defaultDraft ?? {
    mode: defaultCap === null ? "unlimited" : "limit",
    text: defaultCap === null ? "" : String(defaultCap),
  }

  return (
    <div className="space-y-3 rounded-md border p-3" data-testid="org-usage">
      <div>
        <h3 className="text-sm font-medium">{t("title")}</h3>
        <p className="text-xs text-muted-foreground">
          {report?.month ? t("hint", { month: report.month }) : t("hintNoMonth")}
        </p>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription className="break-words">{error}</AlertDescription>
        </Alert>
      ) : null}

      {!report && !error ? (
        <p className="text-sm text-muted-foreground">{t("loading", { host })}</p>
      ) : null}

      {report ? (
        <>
          <div className="space-y-1.5" data-testid="org-usage-default">
            <Label className="text-xs">{t("defaultLabel")}</Label>
            <div className="flex flex-wrap items-center gap-2">
              {editor(shownDefault, setDefaultDraft, false, "org-usage-default-cap")}
              <Button
                size="sm"
                disabled={
                  busy !== null || defaultDraft === null || draftCap(defaultDraft) === undefined
                }
                onClick={() => void saveDefault()}
                data-testid="org-usage-default-save"
              >
                {busy === "default" ? t("saving") : t("save")}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t("defaultHint")}</p>
          </div>

          {report.membersIncomplete ? (
            <p className="text-xs text-muted-foreground" data-testid="org-usage-incomplete">
              {t("incomplete", { host })}
            </p>
          ) : null}

          {report.members.length > 0 ? (
            <ul className="space-y-1.5" data-testid="org-usage-members">
              {report.members.map(memberRow)}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground" data-testid="org-usage-empty">
              {t("empty")}
            </p>
          )}
        </>
      ) : null}
    </div>
  )
}
