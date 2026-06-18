"use client"

/**
 * User profile editor — the ONE component dual-mounted on the desktop
 * settings shell (`/settings?section=profile`) and the mobile sub-page
 * (`/me/profile`). Edits the local-first `AppSettings.profile` blob via
 * `useUserProfile()`; identity precedence (custom > credential-derived)
 * lives in that hook, not here.
 *
 * Text fields keep a transient draft while focused and persist on blur —
 * no setState-in-effect, no per-keystroke write-queue churn.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { UserRoundIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { useUserProfile } from "@/lib/profile/use-user-profile"

import { ProfileAvatarPicker } from "./profile-avatar-picker"

export const DISPLAY_NAME_MAX = 40
export const BIO_MAX = 280
export const PRONOUNS_MAX = 32
export const STATUS_MAX = 80

export function ProfileSection() {
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
    profile.avatarDataUrl
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
            <div className="flex flex-col gap-1">
              <ProfileAvatarPicker
                value={resolvedAvatarUrl}
                fallbackName={previewName}
                onChange={(dataUrl) => save({ avatarDataUrl: dataUrl ?? "" })}
              />
              {email ? (
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
