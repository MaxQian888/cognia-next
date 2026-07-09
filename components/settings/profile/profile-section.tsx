"use client"

/**
 * User profile editor — the ONE component dual-mounted on the desktop
 * settings shell (embedded in the Account section) and the mobile sub-page
 * (`/me/profile`). Edits the local-first `AppSettings.profile` blob via
 * `useUserProfile()`; identity precedence (custom > credential-derived)
 * lives in that hook, not here.
 *
 * Text fields keep a transient draft while focused and persist on blur —
 * no setState-in-effect, no per-keystroke write-queue churn. A live "how you
 * appear" preview at the top reflects drafts as you type.
 *
 * `showEmail` lets the embedding Account section suppress the read-only email
 * line (it renders the email itself in its plan card); mobile keeps the
 * default so `/me/profile` still shows who you're signed in as.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { UserRoundIcon } from "lucide-react"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { TimezoneSelect } from "@/components/scheduler/timezone-select"
import { deterministicColor, initials } from "@/lib/ui/avatar"
import { deviceTimeZone } from "@/lib/profile/timezone"
import { useUserProfile } from "@/lib/profile/use-user-profile"
import { TIMEZONE_OPTIONS } from "@/types/scheduler"

import { ProfileAvatarPicker } from "./profile-avatar-picker"

export const DISPLAY_NAME_MAX = 40
export const BIO_MAX = 280
export const PRONOUNS_MAX = 32
export const STATUS_MAX = 80

export interface ProfileSectionProps {
  /** Render the read-only "Signed in as {email}" line. Defaults to `true`. */
  showEmail?: boolean
}

export function ProfileSection({ showEmail = true }: ProfileSectionProps = {}) {
  const t = useTranslations("settings.profile")
  const { profile, loaded, resolvedDisplayName, resolvedAvatarUrl, email, save } = useUserProfile()

  // Draft-or-stored pattern: `null` means "not editing — show the stored
  // value"; a string means the user is mid-edit. Avoids syncing state from
  // props in an effect.
  const [nameDraft, setNameDraft] = useState<string | null>(null)
  const [bioDraft, setBioDraft] = useState<string | null>(null)
  const [pronounsDraft, setPronounsDraft] = useState<string | null>(null)
  const [statusDraft, setStatusDraft] = useState<string | null>(null)

  const nameValue = nameDraft ?? profile.displayName ?? ""
  const bioValue = bioDraft ?? profile.bio ?? ""
  const pronounsValue = pronounsDraft ?? profile.pronouns ?? ""
  const statusValue = statusDraft ?? profile.statusMessage ?? ""
  const previewName = resolvedDisplayName ?? t("fallbackName")
  // Live preview name follows the in-progress draft, then the credential
  // fallback — so the preview updates while typing, before blur commits.
  const previewDisplayName = nameValue.trim() || previewName

  // The picker value falls back to the device zone (only when it's one of the
  // offered options, else UTC) so the control never renders blank.
  const deviceTz = deviceTimeZone()
  const timezoneValue =
    profile.timezone ??
    (TIMEZONE_OPTIONS.some((option) => option.value === deviceTz) ? deviceTz : "UTC")

  const commitName = () => {
    if (nameDraft === null) return
    const trimmed = nameDraft.trim().slice(0, DISPLAY_NAME_MAX)
    setNameDraft(null)
    if (trimmed !== (profile.displayName ?? "")) void save({ displayName: trimmed })
  }

  const commitBio = () => {
    if (bioDraft === null) return
    const trimmed = bioDraft.trim().slice(0, BIO_MAX)
    setBioDraft(null)
    if (trimmed !== (profile.bio ?? "")) void save({ bio: trimmed })
  }

  const commitPronouns = () => {
    if (pronounsDraft === null) return
    const trimmed = pronounsDraft.trim().slice(0, PRONOUNS_MAX)
    setPronounsDraft(null)
    if (trimmed !== (profile.pronouns ?? "")) void save({ pronouns: trimmed })
  }

  const commitStatus = () => {
    if (statusDraft === null) return
    const trimmed = statusDraft.trim().slice(0, STATUS_MAX)
    setStatusDraft(null)
    if (trimmed !== (profile.statusMessage ?? "")) void save({ statusMessage: trimmed })
  }

  const hasAnyProfile = Boolean(
    profile.displayName ||
    profile.bio ||
    profile.pronouns ||
    profile.statusMessage ||
    profile.avatarDataUrl ||
    profile.timezone
  )

  return (
    <div className="space-y-6" data-testid="profile-section">
      <div className="space-y-1">
        <Label className="flex items-center gap-2">
          <UserRoundIcon className="size-4" />
          {t("title")}
        </Label>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>

      {!loaded ? (
        <Skeleton className="h-40 w-full" data-testid="profile-section-skeleton" />
      ) : (
        <Card>
          <CardContent className="flex flex-col gap-6 pt-6">
            <div className="flex flex-col gap-2" data-testid="profile-preview">
              <span className="text-xs font-medium text-muted-foreground">{t("previewTitle")}</span>
              <div className="flex items-center gap-3 rounded-lg border bg-muted/40 p-3">
                <Avatar className="size-12">
                  {resolvedAvatarUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- avatar is a small data: URL, not an optimizable remote asset
                    <img
                      src={resolvedAvatarUrl}
                      alt=""
                      className="size-full object-cover"
                      data-testid="profile-preview-avatar"
                    />
                  ) : (
                    <AvatarFallback
                      style={{ backgroundColor: deterministicColor(previewDisplayName) }}
                    >
                      {initials(previewDisplayName)}
                    </AvatarFallback>
                  )}
                </Avatar>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span
                      className="truncate text-sm font-semibold"
                      data-testid="profile-preview-name"
                    >
                      {previewDisplayName}
                    </span>
                    {pronounsValue ? (
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {pronounsValue}
                      </span>
                    ) : null}
                  </div>
                  {statusValue ? (
                    <p
                      className="truncate text-xs text-muted-foreground"
                      data-testid="profile-preview-status"
                    >
                      {statusValue}
                    </p>
                  ) : (
                    <p className="truncate text-xs text-muted-foreground/70">{t("previewHint")}</p>
                  )}
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <ProfileAvatarPicker
                value={resolvedAvatarUrl}
                fallbackName={previewName}
                onChange={(dataUrl) => save({ avatarDataUrl: dataUrl ?? "" })}
              />
              {showEmail && email ? (
                <p className="text-xs text-muted-foreground" data-testid="profile-email">
                  {t("emailReadOnly", { email })}
                </p>
              ) : null}
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="profile-display-name">{t("displayNameLabel")}</Label>
              <Input
                id="profile-display-name"
                value={nameValue}
                maxLength={DISPLAY_NAME_MAX}
                placeholder={t("displayNamePlaceholder")}
                onChange={(e) => setNameDraft(e.target.value)}
                onBlur={commitName}
                data-testid="profile-display-name"
              />
              <p className="text-xs text-muted-foreground">{t("displayNameHint")}</p>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="profile-pronouns">{t("pronounsLabel")}</Label>
              <Input
                id="profile-pronouns"
                value={pronounsValue}
                maxLength={PRONOUNS_MAX}
                placeholder={t("pronounsPlaceholder")}
                onChange={(e) => setPronounsDraft(e.target.value)}
                onBlur={commitPronouns}
                data-testid="profile-pronouns"
              />
              <p className="text-xs text-muted-foreground">{t("pronounsHint")}</p>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="profile-status">{t("statusLabel")}</Label>
              <Input
                id="profile-status"
                value={statusValue}
                maxLength={STATUS_MAX}
                placeholder={t("statusPlaceholder")}
                onChange={(e) => setStatusDraft(e.target.value)}
                onBlur={commitStatus}
                data-testid="profile-status"
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label>{t("timezoneLabel")}</Label>
              <TimezoneSelect
                value={timezoneValue}
                onValueChange={(tz) => void save({ timezone: tz })}
                includeOffset
                testId="profile-timezone"
                triggerClassName="w-full"
              />
              <p className="text-xs text-muted-foreground">{t("timezoneHint")}</p>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="profile-bio">{t("bioLabel")}</Label>
              <Textarea
                id="profile-bio"
                value={bioValue}
                maxLength={BIO_MAX}
                rows={3}
                placeholder={t("bioPlaceholder")}
                onChange={(e) => setBioDraft(e.target.value)}
                onBlur={commitBio}
                data-testid="profile-bio"
              />
              <p
                className="text-right text-xs text-muted-foreground"
                data-testid="profile-bio-counter"
              >
                {t("bioCounter", { count: bioValue.length, max: BIO_MAX })}
              </p>
            </div>

            {hasAnyProfile ? (
              <div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    void save({
                      displayName: "",
                      bio: "",
                      pronouns: "",
                      statusMessage: "",
                      avatarDataUrl: "",
                      timezone: "",
                    })
                  }
                  data-testid="profile-reset"
                >
                  {t("reset")}
                </Button>
              </div>
            ) : null}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
