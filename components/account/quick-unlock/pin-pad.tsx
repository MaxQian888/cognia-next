"use client"

// The PIN keypad.
//
// Written for a thumb first and a keyboard second, because the two places a
// PIN is actually used are a phone and a laptop someone is holding. That means
// large targets, no hover-dependent affordances, and physical-keyboard entry
// that works without ever focusing a specific button.
//
// The filled-dot readout deliberately shows COUNT and not value. A PIN is
// short enough to read off a screen at a glance, and the whole point of using
// one is that it gets typed in public.

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { DeleteIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { MAX_PIN_LENGTH, MIN_PIN_LENGTH } from "@/lib/accounts/quick-unlock/types"

export interface PinPadProps {
  /** Called once the user commits a PIN. */
  onSubmit: (pin: string) => void
  disabled?: boolean
  /** Renders the error state and shakes the readout. */
  error?: string | null
  /** Shown under the readout, for example attempts remaining. */
  hint?: string
  /**
   * Commit as soon as this many digits are entered.
   *
   * Only set where the length is genuinely known, which is the confirm step of
   * enrollment. On the lock screen the length is not known, and auto-committing
   * at a guess would submit half a PIN and burn an attempt.
   */
  autoSubmitAt?: number
  /** Overrides the default label, for the enrollment confirm step. */
  submitLabel?: string
  testIdPrefix?: string
}

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"]

export function PinPad({
  onSubmit,
  disabled = false,
  error = null,
  hint,
  autoSubmitAt,
  submitLabel,
  testIdPrefix = "pin",
}: PinPadProps) {
  const t = useTranslations("account.quickUnlock.pin")
  const [digits, setDigits] = useState("")
  const containerRef = useRef<HTMLDivElement>(null)

  const canSubmit = digits.length >= MIN_PIN_LENGTH && !disabled

  const submit = useCallback(
    (value: string) => {
      if (value.length < MIN_PIN_LENGTH) return
      onSubmit(value)
      setDigits("")
    },
    [onSubmit]
  )

  const append = useCallback(
    (digit: string) => {
      if (disabled) return
      setDigits((current) => {
        if (current.length >= MAX_PIN_LENGTH) return current
        const next = current + digit
        // Deferred out of the state updater: committing during render would
        // update the parent mid-render, and React rightly complains.
        if (autoSubmitAt !== undefined && next.length === autoSubmitAt) {
          queueMicrotask(() => submit(next))
        }
        return next
      })
    },
    [disabled, autoSubmitAt, submit]
  )

  const backspace = useCallback(() => {
    if (disabled) return
    setDigits((current) => current.slice(0, -1))
  }, [disabled])

  // Physical-keyboard entry, captured at the container so it works without the
  // user having to find and focus a particular button first.
  useEffect(() => {
    const node = containerRef.current
    if (!node) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (disabled) return
      if (/^\d$/.test(event.key)) {
        event.preventDefault()
        append(event.key)
        return
      }
      if (event.key === "Backspace") {
        event.preventDefault()
        backspace()
        return
      }
      if (event.key === "Enter") {
        event.preventDefault()
        setDigits((current) => {
          if (current.length >= MIN_PIN_LENGTH) queueMicrotask(() => submit(current))
          return current
        })
      }
    }
    node.addEventListener("keydown", onKeyDown)
    return () => node.removeEventListener("keydown", onKeyDown)
  }, [append, backspace, submit, disabled])

  // Focus on mount so keystrokes land somewhere from the first one.
  useEffect(() => {
    containerRef.current?.focus()
  }, [])

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      className="flex flex-col items-center gap-4 outline-none"
      data-testid={`${testIdPrefix}-pad`}
      role="group"
      aria-label={t("label")}
    >
      <div className="flex flex-col items-center gap-1.5">
        <div
          className={cn(
            "flex h-8 items-center gap-2",
            error && "motion-safe:animate-[cognia-shake_320ms_ease-in-out]"
          )}
          data-testid={`${testIdPrefix}-readout`}
          // The COUNT is announced, never the digits.
          aria-label={t("entered", { count: digits.length })}
          aria-live="polite"
        >
          {Array.from({ length: Math.max(MIN_PIN_LENGTH, digits.length) }).map((_, index) => (
            <span
              key={index}
              className={cn(
                "size-3 rounded-full border transition-colors",
                index < digits.length ? "border-primary bg-primary" : "border-muted-foreground/40"
              )}
            />
          ))}
        </div>
        {error ? (
          <p className="text-xs text-destructive" role="alert">
            {error}
          </p>
        ) : hint ? (
          <p className="text-xs text-muted-foreground">{hint}</p>
        ) : null}
      </div>

      <div className="grid grid-cols-3 gap-3">
        {KEYS.map((key) => (
          <PadButton
            key={key}
            label={key}
            disabled={disabled}
            onPress={() => append(key)}
            testId={`${testIdPrefix}-key-${key}`}
          />
        ))}
        <PadButton
          label={t("clear")}
          variant="ghost"
          disabled={disabled || digits.length === 0}
          onPress={() => setDigits("")}
          testId={`${testIdPrefix}-clear`}
          small
        />
        <PadButton
          label="0"
          disabled={disabled}
          onPress={() => append("0")}
          testId={`${testIdPrefix}-key-0`}
        />
        <PadButton
          label={t("backspace")}
          variant="ghost"
          icon={<DeleteIcon className="size-5" />}
          disabled={disabled || digits.length === 0}
          onPress={backspace}
          testId={`${testIdPrefix}-backspace`}
        />
      </div>

      {autoSubmitAt === undefined && (
        <Button
          type="button"
          className="w-full"
          disabled={!canSubmit}
          onClick={() => submit(digits)}
          data-testid={`${testIdPrefix}-submit`}
        >
          {submitLabel ?? t("submit")}
        </Button>
      )}
    </div>
  )
}

interface PadButtonProps {
  label: string
  onPress: () => void
  disabled?: boolean
  variant?: "outline" | "ghost"
  icon?: React.ReactNode
  testId: string
  small?: boolean
}

function PadButton({
  label,
  onPress,
  disabled,
  variant = "outline",
  icon,
  testId,
  small,
}: PadButtonProps) {
  return (
    <Button
      type="button"
      variant={variant}
      // 64px square: comfortably above the 44px touch-target floor, and big
      // enough to hit without looking.
      className={cn("size-16 rounded-stage text-xl font-normal tabular-nums", small && "text-xs")}
      disabled={disabled}
      onClick={onPress}
      aria-label={label}
      data-testid={testId}
    >
      {icon ?? label}
    </Button>
  )
}
