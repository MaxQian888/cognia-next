"use client"

/**
 * Settings → Data: what may be shared from conversations' files (ADR-0222
 * §6.4). Two policies, and sharing follows whichever is stricter field by
 * field (`intersectFileSharingPolicies`):
 *
 * - The person's own, in `AppSettings.fileSharing`.
 * - Their organization's, on the collaboration plane, when the account
 *   belongs to one. Owners and admins edit it here; everyone else sees it.
 *   The plane decides every save; a save from a stale read comes back as a
 *   conflict with the current policy, which replaces the edit.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { createLogger } from "@cognia/logging"

import { Button } from "@/components/ui/button"
import { useMembershipAdmin } from "@/hooks/workspace/use-membership-admin"
import {
  CollabConflictError,
  CollabError,
  type CollabFileSharingPolicy,
  type CollabFileSharingSettings,
} from "@/lib/collab/client"
import { getOrgFileSharingPolicy, saveOrgFileSharingPolicy } from "@/lib/collab/file-sharing-policy"
import type { CurrentCollabContext } from "@/lib/collab/runtime-client"
import { getSettings, saveSettings } from "@/lib/db/settings"
import { resolveLocalFileSharingPolicy, type FileSharingPolicy } from "@/lib/filespace/policy"
import { FILE_SHARING_POLICY_SETTING_ID } from "@/lib/filespace/settings-links"

import { FileSharingPolicyFields } from "./file-sharing-policy-fields"

const log = createLogger("file-sharing-policy")

function samePolicy(a: FileSharingPolicy, b: FileSharingPolicy): boolean {
  return (Object.keys(a) as (keyof FileSharingPolicy)[]).every((key) => a[key] === b[key])
}

function settingsOf(
  policy: CollabFileSharingPolicy | FileSharingPolicy
): CollabFileSharingSettings {
  return {
    allowPublicSnapshots: policy.allowPublicSnapshots,
    allowLiveGrants: policy.allowLiveGrants,
    allowProtocolCredentials: policy.allowProtocolCredentials,
    allowLiveWrite: policy.allowLiveWrite,
    allowAgentSharing: policy.allowAgentSharing,
    maxSnapshotTtlSeconds: policy.maxSnapshotTtlSeconds,
    maxLiveTtlSeconds: policy.maxLiveTtlSeconds,
  }
}

export function FileSharingPolicyCard() {
  const t = useTranslations("share.policy")
  return (
    <div
      className="space-y-4 rounded-lg border p-4"
      data-setting-id={FILE_SHARING_POLICY_SETTING_ID}
    >
      <div>
        <h3 className="text-sm font-medium">{t("title")}</h3>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>
      <PersonalPolicySection />
      <OrgPolicySection />
    </div>
  )
}

function PersonalPolicySection() {
  const t = useTranslations("share.policy")
  const [saved, setSaved] = useState<FileSharingPolicy | null>(null)
  const [draft, setDraft] = useState<FileSharingPolicy | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let current = true
    void getSettings().then(
      (settings) => {
        if (!current) return
        const policy = resolveLocalFileSharingPolicy(settings.fileSharing)
        setSaved(policy)
        setDraft(policy)
      },
      (error: unknown) =>
        log.error("file-sharing-policy-load-failed", {
          error: error instanceof Error ? error.message : String(error),
        })
    )
    return () => {
      current = false
    }
  }, [])

  if (!saved || !draft) return null

  const onSave = async () => {
    setSaving(true)
    try {
      await saveSettings({ fileSharing: draft })
      setSaved(draft)
      toast.success(t("saved"))
    } catch (error) {
      log.error("file-sharing-policy-save-failed", {
        error: error instanceof Error ? error.message : String(error),
      })
      toast.error(t("saveFailed"))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="space-y-3" aria-labelledby="file-sharing-policy-personal">
      <h4
        id="file-sharing-policy-personal"
        className="text-xs font-medium uppercase text-muted-foreground"
      >
        {t("personal.title")}
      </h4>
      <FileSharingPolicyFields
        idPrefix="personal"
        value={draft}
        onChange={setDraft}
        disabled={saving}
      />
      <div className="flex justify-end">
        <Button
          size="sm"
          onClick={() => void onSave()}
          disabled={saving || samePolicy(draft, saved)}
        >
          {t("save")}
        </Button>
      </div>
    </section>
  )
}

type OrgLoad =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ready"; policy: CollabFileSharingPolicy }

function OrgPolicySection() {
  const t = useTranslations("share.policy")
  const admin = useMembershipAdmin(null)
  const context = admin.context
  // Bumped to refetch after a failure.
  const [attempt, setAttempt] = useState(0)
  const [load, setLoad] = useState<{ key: string; value: OrgLoad } | null>(null)
  const loadKey = context ? `${context.orgId}\n${context.localAccountId}\n${attempt}` : ""

  useEffect(() => {
    if (!context) return
    let current = true
    void getOrgFileSharingPolicy(context, { refresh: true }).then(
      (policy) => {
        if (current) setLoad({ key: loadKey, value: { status: "ready", policy } })
      },
      (error: unknown) => {
        log.warn("org-file-sharing-policy-load-failed", {
          error: error instanceof Error ? error.message : String(error),
        })
        if (current) setLoad({ key: loadKey, value: { status: "failed" } })
      }
    )
    return () => {
      current = false
    }
  }, [context, loadKey])

  if (!context) return null
  const state: OrgLoad = load?.key === loadKey ? load.value : { status: "loading" }

  return (
    <section className="space-y-3 border-t pt-4" aria-labelledby="file-sharing-policy-org">
      <div>
        <h4
          id="file-sharing-policy-org"
          className="text-xs font-medium uppercase text-muted-foreground"
        >
          {t("org.title")}
        </h4>
        <p className="text-xs text-muted-foreground">{t("org.description")}</p>
      </div>
      {state.status === "loading" ? (
        <p className="text-xs text-muted-foreground">{t("org.loading")}</p>
      ) : state.status === "failed" ? (
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-destructive">{t("org.loadFailed")}</p>
          <Button size="sm" variant="outline" onClick={() => setAttempt((n) => n + 1)}>
            {t("org.retry")}
          </Button>
        </div>
      ) : (
        <OrgPolicyEditor
          key={`${loadKey}\n${state.policy.revision}`}
          context={context}
          policy={state.policy}
          canManage={admin.canManageOrg}
          onSaved={(policy) => setLoad({ key: loadKey, value: { status: "ready", policy } })}
        />
      )}
    </section>
  )
}

function OrgPolicyEditor({
  context,
  policy,
  canManage,
  onSaved,
}: {
  context: CurrentCollabContext
  policy: CollabFileSharingPolicy
  canManage: boolean
  /** The policy the plane now holds: the saved one, or the winner of a conflict. */
  onSaved: (policy: CollabFileSharingPolicy) => void
}) {
  const t = useTranslations("share.policy")
  const base = settingsOf(policy)
  const [draft, setDraft] = useState<FileSharingPolicy>(base)
  const [saving, setSaving] = useState(false)

  const onSave = async () => {
    setSaving(true)
    try {
      onSaved(await saveOrgFileSharingPolicy(context, settingsOf(draft), policy.revision))
      toast.success(t("org.saved"))
    } catch (error) {
      if (error instanceof CollabConflictError) {
        toast.error(t("org.conflict"))
        onSaved(error.authoritative as CollabFileSharingPolicy)
      } else if (error instanceof CollabError && error.status === 403) {
        toast.error(t("org.forbidden"))
      } else {
        log.error("org-file-sharing-policy-save-failed", {
          error: error instanceof Error ? error.message : String(error),
        })
        toast.error(t("org.saveFailed"))
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-3">
      {!canManage ? <p className="text-xs text-muted-foreground">{t("org.readOnly")}</p> : null}
      <FileSharingPolicyFields
        idPrefix="org"
        value={draft}
        onChange={setDraft}
        disabled={!canManage || saving}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {policy.updatedAt
            ? t("org.updated", { date: new Date(policy.updatedAt).toLocaleString() })
            : t("org.defaults")}
        </p>
        {canManage ? (
          <Button
            size="sm"
            onClick={() => void onSave()}
            disabled={saving || samePolicy(draft, base)}
          >
            {t("org.save")}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
