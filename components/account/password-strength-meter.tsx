"use client"

import { useTranslations } from "next-intl"

import { Progress } from "@/components/ui/progress"
import { cn } from "@/lib/utils"
import { scorePasswordStrength } from "@/lib/accounts/password-policy"

export interface PasswordStrengthMeterProps {
  password: string
  className?: string
}

// Recolour the shared Progress indicator via a child selector so we never have
// to fork components/ui/progress.tsx (a vendored shadcn primitive).
const INDICATOR_COLOR: Record<0 | 1 | 2 | 3 | 4, string> = {
  0: "[&>[data-slot=progress-indicator]]:bg-destructive",
  1: "[&>[data-slot=progress-indicator]]:bg-destructive",
  2: "[&>[data-slot=progress-indicator]]:bg-amber-500",
  3: "[&>[data-slot=progress-indicator]]:bg-lime-500",
  4: "[&>[data-slot=progress-indicator]]:bg-emerald-500",
}

/**
 * Visual-only password strength indicator. Renders nothing for an empty
 * password so the create/change forms stay quiet until the user types.
 */
export function PasswordStrengthMeter({ password, className }: PasswordStrengthMeterProps) {
  const t = useTranslations("account.passwordStrength")
  if (!password) return null

  const { score, label } = scorePasswordStrength(password)
  const pct = (score / 4) * 100

  return (
    <div
      className={cn("flex flex-col gap-1", className)}
      data-testid="password-strength-meter"
      data-score={score}
    >
      <Progress
        value={pct}
        className={cn("h-1.5", INDICATOR_COLOR[score])}
        aria-label={t("aria")}
      />
      <span className="text-xs text-muted-foreground" data-testid="password-strength-label">
        {t(label)}
      </span>
    </div>
  )
}

export default PasswordStrengthMeter
