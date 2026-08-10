"use client"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { listCharacters } from "@/lib/db/characters"
import { loggers } from "@cognia/logging"
import type { Character } from "@cognia/agent-config-types"
import { useSettingsStore } from "@/stores/settings"
import { useClientLiveQuery } from "@/hooks/data"
import { setActiveAccount } from "@/lib/subscription/core/transport"
import type { Account, ProviderId } from "@/types/subscription"
import { AnthropicAddAccountDialog } from "@/components/settings/subscription/add-account-dialog/anthropic"
import { CodexAddAccountDialog } from "@/components/settings/subscription/add-account-dialog/codex"
import { OpencodeAddAccountDialog } from "@/components/settings/subscription/add-account-dialog/opencode"
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckIcon,
  KeyRoundIcon,
  ScanTextIcon,
  ShieldCheckIcon,
  TerminalIcon,
  CableIcon,
  SmartphoneIcon,
  BrainCircuitIcon,
  type LucideIcon,
} from "lucide-react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { useState } from "react"
import { toast } from "sonner"
import { motion, useReducedMotion } from "motion/react"
import { AvatarBadge } from "@/components/desktop/avatar-badge"
import { STAGGER_CHILD, STAGGER_CONTAINER, mobileTransition } from "@/lib/ui/motion"

const log = loggers.ui

type ProviderChoice = "claude" | "codex" | "opencode" | "apiKey"
type Step = "provider" | "character" | "tour"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onPickCharacter: (character: Character) => void
}

interface TourSlide {
  id: "ocr" | "computerUse" | "sandbox" | "connectors" | "mobile" | "twin"
  icon: LucideIcon
  href: string
}

const TOUR_SLIDES: TourSlide[] = [
  // ADR-0028 §UI surfaces — sandbox sits up-front so users see the strict-
  // mode invariant before they touch shell tools.
  { id: "sandbox", icon: ShieldCheckIcon, href: "/settings?section=sandbox" },
  { id: "ocr", icon: ScanTextIcon, href: "/settings?section=ocr" },
  { id: "computerUse", icon: TerminalIcon, href: "/settings?section=automation" },
  { id: "connectors", icon: CableIcon, href: "/settings?section=connections" },
  { id: "mobile", icon: SmartphoneIcon, href: "/settings?section=companion" },
  { id: "twin", icon: BrainCircuitIcon, href: "/settings?section=twin" },
]

/**
 * Desktop first-run wizard. Trigger logic lives in
 * `lib/onboarding/should-show.ts` — by the time this dialog opens, we know
 * the user has no chat sessions, no API key, no active subscription
 * account, and no prior dismissal.
 *
 * Three steps:
 *   1. provider — pick a sign-in method (Claude PKCE / Codex device-code /
 *      OpenCode Zen / paste API key). Reuses the production AddAccount
 *      dialogs verbatim so the OAuth surface stays in one place.
 *   2. character — pick a starting persona (unchanged from the legacy flow).
 *   3. tour — five-card carousel pointing at recent subsystems with deep
 *      links to their Settings pages.
 *
 * Every exit path — Skip, Done, X, Esc, or "Open settings" — calls
 * `dismissOnboarding()` so the modal stays gone on relaunch.
 */
export function OnboardingDialog({ open, onOpenChange, onPickCharacter }: Props) {
  const t = useTranslations("desktop.onboarding")
  const router = useRouter()
  const setApiKey = useSettingsStore((s) => s.setApiKey)
  const dismissOnboarding = useSettingsStore((s) => s.dismissOnboarding)
  const characters = useClientLiveQuery<Character[]>(() => listCharacters(), [], [])

  const [step, setStep] = useState<Step>("provider")
  const [providerDialog, setProviderDialog] = useState<ProviderChoice | null>(null)
  const [connectedProvider, setConnectedProvider] = useState<ProviderId | "apiKey" | null>(null)
  const [keyInput, setKeyInput] = useState("")
  const [saving, setSaving] = useState(false)
  const [tourIndex, setTourIndex] = useState(0)
  const [tourDirection, setTourDirection] = useState<1 | -1>(1)
  const reduce = useReducedMotion() ?? false

  const persistDismiss = async () => {
    try {
      await dismissOnboarding()
    } catch (err) {
      log.error("onboarding dismiss persist failed", err)
    }
  }

  const handleClose = async (reason: string) => {
    log.info("onboarding close", { reason, step })
    await persistDismiss()
    onOpenChange(false)
  }

  const handleProviderCardClick = (choice: ProviderChoice) => {
    log.info("onboarding provider chosen", { choice })
    if (choice === "apiKey") {
      setProviderDialog("apiKey")
      return
    }
    setProviderDialog(choice)
  }

  const handleAccountAdded = async (provider: ProviderId, account: Account) => {
    try {
      await setActiveAccount(provider, account.id)
      log.info("onboarding subscription connected", { provider, accountId: account.id })
      setConnectedProvider(provider)
      setProviderDialog(null)
      setStep("character")
    } catch (err) {
      log.error("onboarding setActiveAccount failed", err)
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const handleSaveKey = async () => {
    const trimmed = keyInput.trim()
    if (!trimmed) {
      log.warn("onboarding api key blank")
      toast.error(t("toastNeedKey"))
      return
    }
    setSaving(true)
    try {
      await setApiKey(trimmed)
      log.info("onboarding api key saved", { length: trimmed.length })
      setConnectedProvider("apiKey")
      setProviderDialog(null)
      setStep("character")
    } catch (err) {
      log.error("onboarding api key save failed", err)
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const handlePickCharacter = async (c: Character) => {
    log.info("onboarding pick character", { characterId: c.id })
    onPickCharacter(c)
    setStep("tour")
  }

  const handleBackToProvider = () => {
    log.info("onboarding back-to-provider")
    setConnectedProvider(null)
    setStep("provider")
  }

  const handleTourNext = () => {
    if (tourIndex < TOUR_SLIDES.length - 1) {
      setTourDirection(1)
      setTourIndex((i) => i + 1)
    } else {
      void handleClose("tour-done")
    }
  }

  const handleTourPrev = () => {
    if (tourIndex > 0) {
      setTourDirection(-1)
      setTourIndex((i) => i - 1)
    }
  }

  const handleTourOpenSettings = async (slide: TourSlide) => {
    log.info("onboarding tour deep-link", { slideId: slide.id, href: slide.href })
    await persistDismiss()
    onOpenChange(false)
    router.push(slide.href)
  }

  const dialogTitle =
    step === "provider" ? t("step1Title") : step === "character" ? t("step2Title") : t("tour.title")
  const dialogDescription =
    step === "provider"
      ? t("step1Description")
      : step === "character"
        ? t("step2Description")
        : t("tour.description")

  return (
    <>
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          if (!next) void handleClose("alert-dialog-close")
        }}
      >
        <AlertDialogContent className="max-w-xl">
          <AlertDialogHeader>
            <AlertDialogTitle>{dialogTitle}</AlertDialogTitle>
            <AlertDialogDescription>{dialogDescription}</AlertDialogDescription>
          </AlertDialogHeader>

          <motion.div
            key={step}
            initial={reduce ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={mobileTransition("fast")}
          >
            {step === "provider" && (
              <ProviderStep
                t={t}
                reduce={reduce}
                connectedProvider={connectedProvider}
                keyInput={keyInput}
                setKeyInput={setKeyInput}
                saving={saving}
                onCardClick={handleProviderCardClick}
                onSaveKey={handleSaveKey}
                onSkip={() => void handleClose("skip-step-provider")}
                onAdvance={() => setStep("character")}
              />
            )}

            {step === "character" && (
              <CharacterStep
                t={t}
                reduce={reduce}
                characters={characters ?? []}
                canGoBack={connectedProvider === null}
                onPick={(c) => void handlePickCharacter(c)}
                onBack={handleBackToProvider}
                onSkip={() => void handleClose("skip-step-character")}
              />
            )}

            {step === "tour" && (
              <TourStep
                t={t}
                reduce={reduce}
                direction={tourDirection}
                index={tourIndex}
                onPrev={handleTourPrev}
                onNext={handleTourNext}
                onSkip={() => void handleClose("skip-step-tour")}
                onOpenSettings={(slide) => void handleTourOpenSettings(slide)}
              />
            )}
          </motion.div>
        </AlertDialogContent>
      </AlertDialog>

      <AnthropicAddAccountDialog
        open={providerDialog === "claude"}
        onOpenChange={(o) => {
          if (!o) setProviderDialog(null)
        }}
        onAdded={(account) => void handleAccountAdded("anthropic", account)}
        initialMode="subscription"
      />
      <CodexAddAccountDialog
        open={providerDialog === "codex"}
        onOpenChange={(o) => {
          if (!o) setProviderDialog(null)
        }}
        onAdded={(account) => void handleAccountAdded("codex", account)}
        initialMode="oauth"
      />
      <OpencodeAddAccountDialog
        open={providerDialog === "opencode"}
        onOpenChange={(o) => {
          if (!o) setProviderDialog(null)
        }}
        onAdded={(account) => void handleAccountAdded("opencode", account)}
      />
    </>
  )
}

interface ProviderStepProps {
  t: (key: string, params?: Record<string, string | number>) => string
  reduce: boolean
  connectedProvider: ProviderId | "apiKey" | null
  keyInput: string
  setKeyInput: (v: string) => void
  saving: boolean
  onCardClick: (choice: ProviderChoice) => void
  onSaveKey: () => void
  onSkip: () => void
  onAdvance: () => void
}

function ProviderStep({
  t,
  reduce,
  connectedProvider,
  keyInput,
  setKeyInput,
  saving,
  onCardClick,
  onSaveKey,
  onSkip,
  onAdvance,
}: ProviderStepProps) {
  if (connectedProvider) {
    const providerLabel =
      connectedProvider === "apiKey"
        ? t("provider.apiKey.title")
        : t(`provider.${connectedProvider}.title`)
    return (
      <div className="space-y-3 py-2" data-testid="onboarding-connected">
        <div className="rounded-md border border-success/40 bg-success/10 p-3">
          <p className="text-sm font-medium">
            {t("provider.loggedInBadge")} — {providerLabel}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("provider.loggedInDescription", { provider: providerLabel })}
          </p>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" size="sm" onClick={onSkip}>
            {t("skip")}
          </Button>
          <Button size="sm" onClick={onAdvance}>
            {t("continue")}
            <ArrowRightIcon className="ml-1 size-3.5" />
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3 py-2">
      <motion.div
        className="grid grid-cols-1 gap-2 sm:grid-cols-2"
        variants={STAGGER_CONTAINER}
        initial={reduce ? false : "initial"}
        animate="animate"
      >
        {(
          [
            { providerKey: "claude" as const },
            { providerKey: "codex" as const },
            { providerKey: "opencode" as const },
            { providerKey: "apiKey" as const, icon: KeyRoundIcon },
          ] satisfies { providerKey: ProviderChoice; icon?: LucideIcon }[]
        ).map(({ providerKey, icon }) => (
          <motion.div key={providerKey} variants={STAGGER_CHILD}>
            <ProviderCard
              providerKey={providerKey}
              icon={icon}
              title={t(`provider.${providerKey}.title`)}
              description={t(`provider.${providerKey}.description`)}
              cta={t(`provider.${providerKey}.cta`)}
              onClick={() => onCardClick(providerKey)}
            />
          </motion.div>
        ))}
      </motion.div>

      <div className="space-y-2 rounded-md border bg-muted/30 p-3">
        <Label htmlFor="onboarding-key" className="text-xs">
          {t("apiKeyLabel")}
        </Label>
        <Input
          id="onboarding-key"
          type="password"
          value={keyInput}
          onChange={(e) => setKeyInput(e.target.value)}
          placeholder={t("apiKeyPlaceholder")}
          className="font-mono text-xs"
        />
        <p className="text-[11px] text-muted-foreground">
          {t("apiKeyHintPrefix")}
          <code className="rounded bg-muted px-1">{t("apiKeyHintHost")}</code>
          {t("apiKeyHintSuffix")}
        </p>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" size="sm" onClick={onSkip}>
            {t("skip")}
          </Button>
          <Button size="sm" onClick={onSaveKey} disabled={saving}>
            {saving ? t("saving") : t("continue")}
            <ArrowRightIcon className="ml-1 size-3.5" />
          </Button>
        </div>
      </div>
    </div>
  )
}

interface ProviderCardProps {
  providerKey: ProviderChoice
  title: string
  description: string
  cta: string
  icon?: LucideIcon
  onClick: () => void
}

function ProviderCard({
  providerKey,
  title,
  description,
  cta,
  icon: Icon,
  onClick,
}: ProviderCardProps) {
  return (
    <Button
      type="button"
      variant="outline"
      onClick={onClick}
      data-testid={`onboarding-provider-${providerKey}`}
      className="h-full w-full flex-col items-stretch justify-start gap-1 whitespace-normal p-3 text-left font-normal motion-safe:hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md"
    >
      <div className="flex items-center gap-2">
        {Icon && <Icon className="size-4 text-muted-foreground" aria-hidden />}
        <span className="text-sm font-medium">{title}</span>
      </div>
      <p className="line-clamp-2 text-[11px] text-muted-foreground">{description}</p>
      <span className="mt-1 text-[11px] font-medium text-primary">{cta} →</span>
    </Button>
  )
}

interface CharacterStepProps {
  t: (key: string) => string
  reduce: boolean
  characters: Character[]
  canGoBack: boolean
  onPick: (c: Character) => void
  onBack: () => void
  onSkip: () => void
}

function CharacterStep({
  t,
  reduce,
  characters,
  canGoBack,
  onPick,
  onBack,
  onSkip,
}: CharacterStepProps) {
  return (
    <div className="space-y-3 py-2">
      <motion.div
        className="grid max-h-72 grid-cols-1 gap-2 overflow-y-auto pr-2 sm:grid-cols-2"
        variants={STAGGER_CONTAINER}
        initial={reduce ? false : "initial"}
        animate="animate"
      >
        {characters.map((c) => (
          <motion.div key={c.id} variants={STAGGER_CHILD}>
            <Button
              type="button"
              variant="outline"
              onClick={() => onPick(c)}
              className="h-full w-full items-start justify-start gap-2 whitespace-normal p-2 text-left text-sm font-normal motion-safe:hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md"
            >
              <AvatarBadge subject={c} size={32} textClassName="text-sm" />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{c.name}</p>
                {c.description && (
                  <p className="line-clamp-2 text-[11px] text-muted-foreground">{c.description}</p>
                )}
              </div>
            </Button>
          </motion.div>
        ))}
      </motion.div>
      <div className="flex justify-between gap-2 pt-2">
        <Button variant="ghost" size="sm" onClick={onBack} disabled={!canGoBack}>
          <ArrowLeftIcon className="mr-1 size-3.5" />
          {t("provider.backToChooser")}
        </Button>
        <Button variant="ghost" size="sm" onClick={onSkip}>
          {t("skip")}
        </Button>
      </div>
    </div>
  )
}

interface TourStepProps {
  t: (key: string, params?: Record<string, string | number>) => string
  reduce: boolean
  direction: 1 | -1
  index: number
  onPrev: () => void
  onNext: () => void
  onSkip: () => void
  onOpenSettings: (slide: TourSlide) => void
}

function TourStep({
  t,
  reduce,
  direction,
  index,
  onPrev,
  onNext,
  onSkip,
  onOpenSettings,
}: TourStepProps) {
  const slide = TOUR_SLIDES[index]
  const Icon = slide.icon
  const isLast = index === TOUR_SLIDES.length - 1
  return (
    <div className="space-y-3 py-2">
      <motion.div
        key={slide.id}
        initial={reduce ? false : { opacity: 0, x: direction * 16 }}
        animate={{ opacity: 1, x: 0 }}
        transition={mobileTransition("fast")}
        className="rounded-md border bg-muted/30 p-4"
        data-testid={`onboarding-tour-slide-${slide.id}`}
      >
        <div className="flex items-start gap-3">
          <Icon className="mt-0.5 size-5 text-primary" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{t(`tour.${slide.id}.title`)}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t(`tour.${slide.id}.description`)}
            </p>
            <Button
              variant="ghost"
              size="sm"
              className="mt-2 h-auto px-2 py-1 text-[11px]"
              onClick={() => onOpenSettings(slide)}
            >
              {t(`tour.${slide.id}.cta`)}
              <ArrowRightIcon className="ml-1 size-3" />
            </Button>
          </div>
        </div>
      </motion.div>
      <div className="flex items-center justify-between gap-2 pt-1">
        <Button variant="ghost" size="sm" onClick={onSkip}>
          {t("tour.skip")}
        </Button>
        <div className="flex items-center gap-1.5" aria-hidden>
          {TOUR_SLIDES.map((s, i) => (
            <span
              key={s.id}
              className={`h-1.5 rounded-full transition-all ${
                i === index ? "w-4 bg-primary" : "w-1.5 bg-muted-foreground/30"
              }`}
            />
          ))}
        </div>
        <span className="sr-only" aria-live="polite">
          {t("tour.progress", { current: index + 1, total: TOUR_SLIDES.length })}
        </span>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={onPrev} disabled={index === 0}>
            <ArrowLeftIcon className="size-3.5" />
            {t("tour.previous")}
          </Button>
          <Button size="sm" onClick={onNext}>
            {isLast ? (
              <>
                <CheckIcon className="mr-1 size-3.5" />
                {t("tour.done")}
              </>
            ) : (
              <>
                {t("tour.next")}
                <ArrowRightIcon className="ml-1 size-3.5" />
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  )
}
