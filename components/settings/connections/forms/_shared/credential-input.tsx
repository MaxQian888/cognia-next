"use client"

/**
 * CredentialInput — the single keyring-backed field every connector form renders,
 * for secrets (masked, with a reveal toggle) and for the identifiers stored
 * beside them (`sensitive={false}`).
 *
 * Before this existed each of the eleven platform dialogs hand-rolled
 * `<Input type="password" autoComplete="new-password" />` with an empty
 * `useState` and a "leave blank to keep the current value" placeholder. That
 * made three things impossible at once: you could not see whether a
 * credential had ever been stored, you could not read back the one you saved,
 * and every form disagreed about what an empty box meant.
 *
 * The four states below are the whole model. They are deliberately distinct
 * because each one implies a different meaning for an empty input:
 *
 *   - `new`     the adapter does not exist yet. Empty = nothing to store.
 *   - `unset`   the adapter exists but this credential was never stored.
 *               Empty = still nothing to store.
 *   - `loaded`  the stored value was read back and IS `value`. Empty now
 *               means the operator deleted it — the form must treat that as
 *               a clear, not as "no change". That is why `loaded` is its own
 *               state rather than being folded into `stored`.
 *   - `stored`  a value exists on the host but this shell may not read it
 *               (a remote UI without an admin lease, or a refused read).
 *               Empty = keep whatever is there; typing = overwrite.
 *
 * Plus two transient states, `loading` and `error`, so a slow or failed
 * keyring read is visible instead of looking like "never configured".
 *
 * The component owns only the reveal toggle. The value, the status and the
 * save semantics belong to the form (see `use-adapter-credentials`), because
 * only the form knows which credentials are required on which transport.
 */

import { useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  EyeIcon,
  EyeOffIcon,
  LoaderIcon,
  LockIcon,
  RotateCwIcon,
} from "lucide-react"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import { cn } from "@/lib/utils"

/** @see the module docblock — each value implies a different meaning for an empty input. */
export type CredentialFieldStatus = "new" | "loading" | "loaded" | "unset" | "stored" | "error"

export interface CredentialInputProps {
  id: string
  value: string
  onChange: (next: string) => void
  status: CredentialFieldStatus
  /**
   * Mask the value and offer a reveal toggle. Default true.
   *
   * Set false for the keyring-backed *identifiers* every platform pairs with
   * its secret — DingTalk `appKey`, Lark `appId`, WeCom `botId`. They need the
   * same prefill and the same honest status line, but masking an identifier
   * only makes it harder to check against the platform console.
   */
  sensitive?: boolean
  /** Placeholder used when there is nothing stored (`new` / `unset`). */
  placeholder?: string
  disabled?: boolean
  /**
   * Rendered to the right of the input, inside the same row — the platform
   * forms put their "Test connection" button here.
   */
  trailing?: ReactNode
  /**
   * Why the stored value cannot be read in this shell. Required in spirit
   * when `status === "stored"`; a generic line is used when omitted.
   */
  unavailableReason?: string
  /** Retry affordance for `status === "error"`. */
  onRetry?: () => void
  className?: string
}

export function CredentialInput({
  id,
  value,
  onChange,
  status,
  sensitive = true,
  placeholder,
  disabled,
  trailing,
  unavailableReason,
  onRetry,
  className,
}: CredentialInputProps) {
  const t = useTranslations("settings.connections.credentialField")
  const [revealed, setRevealed] = useState(false)

  const statusId = `${id}-status`
  const loading = status === "loading"
  // Nothing to reveal when the box is empty; keeping the toggle enabled there
  // would offer a control that visibly does nothing.
  const canReveal = value.length > 0 && !loading
  const masked = sensitive && !revealed

  const effectivePlaceholder =
    status === "stored"
      ? t("storedPlaceholder")
      : status === "loading"
        ? t("loadingPlaceholder")
        : placeholder

  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-start gap-2">
        <InputGroup className="min-w-0 flex-1">
          <InputGroupInput
            id={id}
            type={masked ? "password" : "text"}
            autoComplete={sensitive ? "new-password" : "off"}
            spellCheck={false}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={effectivePlaceholder}
            disabled={disabled || loading}
            aria-describedby={statusId}
            data-credential-status={status}
          />
          {sensitive ? (
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                type="button"
                size="icon-xs"
                onClick={() => setRevealed((prev) => !prev)}
                disabled={!canReveal || disabled}
                aria-label={revealed ? t("hideAria") : t("revealAria")}
                aria-pressed={revealed}
              >
                {revealed ? <EyeOffIcon /> : <EyeIcon />}
              </InputGroupButton>
            </InputGroupAddon>
          ) : null}
        </InputGroup>
        {trailing}
      </div>
      <CredentialStatusLine
        id={statusId}
        status={status}
        unavailableReason={unavailableReason}
        onRetry={onRetry}
        disabled={disabled}
      />
    </div>
  )
}

function CredentialStatusLine({
  id,
  status,
  unavailableReason,
  onRetry,
  disabled,
}: {
  id: string
  status: CredentialFieldStatus
  unavailableReason?: string
  onRetry?: () => void
  disabled?: boolean
}) {
  const t = useTranslations("settings.connections.credentialField")

  // `new` says nothing: an adapter that does not exist yet has no history to
  // report, and a line there would be noise on every create dialog.
  if (status === "new")
    return (
      <span id={id} className="sr-only">
        {t("statusNew")}
      </span>
    )

  if (status === "loading") {
    return (
      <p id={id} className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <LoaderIcon className="size-3 animate-spin" aria-hidden />
        {t("statusLoading")}
      </p>
    )
  }

  if (status === "loaded") {
    return (
      <p id={id} className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <CheckCircle2Icon className="size-3 text-emerald-600 dark:text-emerald-500" aria-hidden />
        {t("statusLoaded")}
      </p>
    )
  }

  if (status === "unset") {
    return (
      <p id={id} className="text-xs text-muted-foreground">
        {t("statusUnset")}
      </p>
    )
  }

  if (status === "stored") {
    return (
      <p id={id} className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <LockIcon className="size-3 shrink-0" aria-hidden />
        <span className="min-w-0">{unavailableReason ?? t("statusStored")}</span>
      </p>
    )
  }

  return (
    <p id={id} className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-500">
      <AlertTriangleIcon className="size-3 shrink-0" aria-hidden />
      <span className="min-w-0">{t("statusError")}</span>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          disabled={disabled}
          className="inline-flex items-center gap-1 underline underline-offset-2 disabled:opacity-50"
        >
          <RotateCwIcon className="size-3" aria-hidden />
          {t("retry")}
        </button>
      ) : null}
    </p>
  )
}
