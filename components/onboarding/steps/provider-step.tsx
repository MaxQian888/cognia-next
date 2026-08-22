"use client"

import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckIcon,
  KeyRoundIcon,
  type LucideIcon,
} from "lucide-react"
import { useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { AnthropicAddAccountDialog } from "@/components/settings/subscription/add-account-dialog/anthropic"
import { Button } from "@/components/ui/button"
import { CodexAddAccountDialog } from "@/components/settings/subscription/add-account-dialog/codex"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { OpencodeAddAccountDialog } from "@/components/settings/subscription/add-account-dialog/opencode"
import { ProviderPicker } from "../provider-picker"
import { StepHeading } from "../step-shell"
import { cn } from "@/lib/utils"
import {
  connectSubscriptionAccount,
  saveBuiltInProviderKey,
} from "@/lib/onboarding/connect-provider"
import {
  initialProviderDraft,
  onboardingProviderOption,
  type OnboardingProviderOption,
} from "@/lib/onboarding/provider-catalog"
import { isStandaloneChatMode } from "@/lib/runtime/standalone-mode"
import { loggers } from "@cognia/logging"
import { useSettingsStore } from "@/stores/settings/settings-store"
import type { Account } from "@/types/subscription"

const log = loggers.ui.child("onboarding-provider")

/** Host of a dashboard URL, for the "get one at …" line. */
function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

type ProviderChoice = "claude" | "codex" | "opencode" | "apiKey"

/** What the key panel opens on. Also the app's own default provider. */
const DEFAULT_KEY_PROVIDER = "anthropic"

/** Stand-in for an id the catalog does not know — only reachable if a
 *  provider is removed from the catalog while its id is selected. */
const FALLBACK_OPTION: OnboardingProviderOption = {
  id: DEFAULT_KEY_PROVIDER,
  name: DEFAULT_KEY_PROVIDER,
  category: "flagship",
  requiresCredential: true,
  requiresBaseUrl: false,
  isLocal: false,
}

/**
 * Which half of the step is showing. Reported upwards so the shell's action
 * row can stand down while the key panel owns the primary action.
 */
export type ProviderView = "chooser" | "apiKey" | "connected"

interface ProviderStepProps {
  /** Fired once credentials are in and persisted. Reporting only — the step
   *  shows what it connected and lets the user continue from the action row. */
  onConnected?: () => void
  /** Lets `OnboardingFlow` drop its Continue while the key panel owns it. */
  onViewChange?: (view: ProviderView) => void
  /**
   * Suppresses the step heading. The recommended screen hosts this component
   * under its own "connect a model" plan line, where a second `<h1>` would
   * both duplicate the line above it and break the heading order.
   */
  heading?: boolean
}

interface ConnectedState {
  card: ProviderChoice
  /** Catalog name, when the key panel configured something other than the card. */
  providerName?: string
  email?: string
  plan?: string
}

/**
 * Step 2 — how Cognia reaches a model.
 *
 * **This step is conditional.** `resolveStepSequence` drops it entirely once
 * the user already has model access — including the case where the scan found
 * an already-authenticated `claude-code`. Asking someone with a working agent
 * CLI to go authenticate again is the kind of step that makes a first run feel
 * like paperwork.
 *
 * The three subscription surfaces reuse the production `AddAccountDialog`s
 * verbatim rather than reimplementing OAuth here, so the credential path stays
 * in one place.
 *
 * **The offer depends on what this shell can actually use.** Subscription
 * accounts live in the OS keyring and are resolved by `resolveAccountEnv`,
 * which returns nothing in standalone mode — a browser with no Companion
 * target, or a phone the user put in BYOK mode. Chat there goes through
 * `resolveStandaloneProvider`, which reads `providerSettings` only. Offering
 * three subscription sign-ins on those shells meant the *entire* browser
 * onboarding (welcome → provider → first run) could complete without producing
 * a single usable credential.
 *
 * **What connecting writes.** Three things, because three separate consumers
 * read three different places: the vault's active pointer
 * (`setActiveAccount`), the ADR-0028 scoped default
 * (`setProviderDefaultAccount`), and `defaultProvider` — without that last one
 * `build-options` falls through to its literal `"anthropic"` default, so a
 * user who connected ChatGPT had their first run dispatched to Anthropic.
 * `setDefaultProvider` also re-syncs `defaultModel` so the pair stays coherent.
 *
 * **Two views, one at a time.** The key form used to sit permanently below the
 * cards, which put two buttons labelled "Continue" on the same screen — one
 * saving a key, one walking past it — and asked everyone to read a form that
 * three of the four sign-in methods never touch.
 */
export function ProviderStep({ onConnected, onViewChange, heading = true }: ProviderStepProps) {
  const t = useTranslations("onboarding")
  const setApiKey = useSettingsStore((s) => s.setApiKey)
  const setProviderConfig = useSettingsStore((s) => s.setProviderConfig)
  const setDefaultProvider = useSettingsStore((s) => s.setDefaultProvider)
  const [dialog, setDialog] = useState<ProviderChoice | null>(null)
  const [view, setView] = useState<ProviderView>("chooser")
  const [connected, setConnected] = useState<ConnectedState | null>(null)
  // Which provider the key panel is configuring. Anthropic is the app's own
  // default, and the card that opens this panel is still framed around it.
  const [providerId, setProviderId] = useState(DEFAULT_KEY_PROVIDER)
  const [keyInput, setKeyInput] = useState("")
  const [baseUrlInput, setBaseUrlInput] = useState("")
  const [saving, setSaving] = useState(false)

  const option = onboardingProviderOption(providerId)
  const needsBaseUrl = Boolean(option && (option.requiresBaseUrl || option.isLocal))
  // A provider this panel can finish. Some (Amazon Bedrock, say) are complete
  // for the shared rules without a key *or* a base URL because what they
  // actually need — a region, an access key pair — lives in fields only the
  // Settings page has. Rendering a form with nothing in it and a Save that
  // "succeeds" would be worse than saying so. Derived, not a hard-coded id
  // list, so a provider added later is classified by its own requirements.
  const configurableHere = Boolean(option && (option.requiresCredential || needsBaseUrl))

  const pickProvider = (next: string) => {
    setProviderId(next)
    // Each provider starts from its own draft — a local server prefills its
    // well-known port, and a key typed for one provider must not ride along to
    // the next one's endpoint.
    const draft = initialProviderDraft(onboardingProviderOption(next) ?? FALLBACK_OPTION)
    setKeyInput(draft.apiKey)
    setBaseUrlInput(draft.baseURL)
  }

  // Read at render rather than through a hook: the value only changes with
  // `mobileRuntimeMode`, which is committed by the welcome step and re-renders
  // the whole flow. See `lib/runtime/standalone-mode.ts`.
  const standalone = isStandaloneChatMode()

  const show = (next: ProviderView) => {
    setView(next)
    onViewChange?.(next)
  }

  const finish = (next: ConnectedState) => {
    setConnected(next)
    show("connected")
    onConnected?.()
  }

  const handleAccountAdded = async (card: Exclude<ProviderChoice, "apiKey">, account: Account) => {
    try {
      // The three pointer writes live in `connect-provider` because the
      // recommended screen's inline block performs exactly the same ones.
      const summary = await connectSubscriptionAccount({ account, setDefaultProvider })
      log.info("onboarding subscription connected", {
        provider: summary.provider,
        accountId: account.id,
        plan: summary.plan,
      })
      setDialog(null)
      finish({ card, email: summary.email, plan: summary.plan })
    } catch (err) {
      log.error("onboarding subscription activation failed", err)
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const handleSaveKey = async () => {
    if (!configurableHere) return
    setSaving(true)
    try {
      // Persistence order, the readiness check and the legacy-slot rule all
      // live in `connect-provider`, shared with the recommended screen.
      const result = await saveBuiltInProviderKey({
        draft: {
          providerId,
          apiKey: keyInput,
          baseURL: baseUrlInput,
          requiresCredential: Boolean(option?.requiresCredential),
          requiresBaseUrl: needsBaseUrl,
        },
        setProviderConfig,
        setDefaultProvider,
        setApiKey,
      })
      if (!result.ok) {
        toast.error(option?.requiresCredential ? t("toastNeedKey") : t("provider.toastIncomplete"))
        return
      }
      log.info("onboarding provider key saved", { providerId, length: keyInput.trim().length })
      finish({ card: "apiKey", providerName: option?.name })
    } catch (err) {
      log.error("onboarding provider key save failed", err)
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const cards: { providerKey: ProviderChoice; icon?: LucideIcon }[] = [
    ...(standalone
      ? []
      : [
          { providerKey: "claude" as const },
          { providerKey: "codex" as const },
          { providerKey: "opencode" as const },
        ]),
    { providerKey: "apiKey", icon: KeyRoundIcon },
  ]

  if (view === "connected" && connected) {
    return (
      <div className="flex flex-col gap-6" data-testid="onboarding-provider">
        {heading && (
          <StepHeading
            title={t("provider.connected.title")}
            description={t("provider.connected.description")}
          />
        )}

        <div
          className="flex flex-col gap-3 rounded-xl border bg-card p-5"
          data-testid="onboarding-provider-connected"
        >
          <span className="flex items-center gap-2">
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-foreground text-background">
              <CheckIcon className="size-3" aria-hidden />
            </span>
            <span className="text-sm font-medium">
              {connected.providerName ?? t(`provider.${connected.card}.title`)}
            </span>
            <span className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground">
              {t("provider.loggedInBadge")}
            </span>
          </span>
          {connected.email && (
            <span className="text-xs text-muted-foreground" data-testid="onboarding-provider-email">
              {connected.email}
            </span>
          )}
          {connected.plan && (
            <span className="text-xs text-muted-foreground" data-testid="onboarding-provider-plan">
              {t("provider.connected.plan", { plan: connected.plan })}
            </span>
          )}
        </div>

        <Button
          variant="ghost"
          size="sm"
          className="self-start text-muted-foreground"
          onClick={() => show("chooser")}
          data-testid="onboarding-provider-back-to-chooser"
        >
          <ArrowLeftIcon className="size-3.5" />
          {t("provider.backToChooser")}
        </Button>
      </div>
    )
  }

  if (view === "apiKey") {
    return (
      <div className="flex flex-col gap-6" data-testid="onboarding-provider">
        {heading && (
          <StepHeading
            title={t("provider.apiKey.title")}
            description={t("provider.apiKey.description")}
          />
        )}

        <div className="flex flex-col gap-4 rounded-xl border bg-muted/30 p-5">
          <div className="flex flex-col gap-2">
            <Label htmlFor="onboarding-provider-id" className="text-xs font-medium">
              {t("provider.pickerLabel")}
            </Label>
            <ProviderPicker
              id="onboarding-provider-id"
              value={providerId}
              onChange={pickProvider}
              disabled={saving}
            />
          </div>

          {option?.requiresCredential && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="onboarding-key" className="text-xs font-medium">
                {t("apiKeyLabel")}
              </Label>
              <Input
                id="onboarding-key"
                type="password"
                autoFocus
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !saving) void handleSaveKey()
                }}
                placeholder={option.placeholderApiKey ?? t("apiKeyPlaceholder")}
                className="h-10 font-mono text-xs"
              />
            </div>
          )}

          {needsBaseUrl && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="onboarding-base-url" className="text-xs font-medium">
                {t("provider.baseUrlLabel")}
              </Label>
              <Input
                id="onboarding-base-url"
                value={baseUrlInput}
                onChange={(e) => setBaseUrlInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !saving) void handleSaveKey()
                }}
                placeholder={option?.defaultBaseUrl ?? "https://"}
                className="h-10 font-mono text-xs"
                data-testid="onboarding-provider-base-url"
              />
            </div>
          )}

          {/* One line, whichever applies: what is missing here, where to get a
              key, or the fact that a local server needs none. */}
          {!configurableHere ? (
            <p
              className="text-xs leading-relaxed text-muted-foreground"
              data-testid="onboarding-provider-needs-settings"
            >
              {t("provider.needsSettings")}
            </p>
          ) : option?.isLocal ? (
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t("provider.localHint")}
            </p>
          ) : (
            <p className="text-xs leading-relaxed text-muted-foreground">
              {option?.dashboardUrl && (
                <>
                  {t("apiKeyHintPrefix")}
                  <code className="rounded bg-muted px-1 py-0.5">
                    {hostOf(option.dashboardUrl)}
                  </code>
                  {". "}
                </>
              )}
              {t("apiKeyHintSuffix")}
            </p>
          )}

          <Button
            className="self-start"
            onClick={() => void handleSaveKey()}
            disabled={saving || !configurableHere}
            data-testid="onboarding-provider-save-key"
          >
            {saving ? t("saving") : t("provider.apiKey.save")}
            <ArrowRightIcon className="size-4" />
          </Button>
        </div>

        {cards.length > 1 && (
          <Button
            variant="ghost"
            size="sm"
            className="self-start text-muted-foreground"
            onClick={() => show("chooser")}
            data-testid="onboarding-provider-back-to-chooser"
          >
            <ArrowLeftIcon className="size-3.5" />
            {t("provider.backToChooser")}
          </Button>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6" data-testid="onboarding-provider">
      {/* With one option, "How do you want to sign in?" is not a question. */}
      {heading && (
        <StepHeading
          title={standalone ? t("provider.byokTitle") : t("provider.title")}
          description={standalone ? t("provider.byokNote") : t("provider.description")}
        />
      )}

      <div
        className={cn(
          "grid gap-3",
          cards.length > 1 ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1"
        )}
      >
        {cards.map(({ providerKey, icon: Icon }) => (
          <button
            key={providerKey}
            type="button"
            onClick={() => (providerKey === "apiKey" ? show("apiKey") : setDialog(providerKey))}
            data-testid={`onboarding-provider-${providerKey}`}
            className="group flex h-full flex-col items-stretch gap-2 rounded-xl border bg-card p-4 text-left transition-all hover:border-primary/40 hover:shadow-md focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 motion-safe:hover:-translate-y-0.5"
          >
            <span className="flex items-center gap-2">
              {Icon && <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
              <span className="text-sm font-medium">{t(`provider.${providerKey}.title`)}</span>
            </span>
            <span className="text-xs leading-relaxed text-muted-foreground">
              {t(`provider.${providerKey}.description`)}
            </span>
            <span className="mt-auto flex items-center gap-1 pt-1 text-xs font-medium text-primary">
              {t(`provider.${providerKey}.cta`)}
              <ArrowRightIcon className="size-3 transition-transform group-hover:translate-x-0.5" />
            </span>
          </button>
        ))}
      </div>

      {/* Mounted only where the vault is reachable — the dialogs talk to the
        Rust subscription commands, which a plain browser has no transport for. */}
      {!standalone && (
        <>
          {/* No `initialMode`: the dialog defaults to `reuse` when it discovers
            an existing Claude Code login, which is precisely the machine the
            scan step just celebrated. Forcing `subscription` here sent that
            user through a full browser PKCE round-trip instead. */}
          <AnthropicAddAccountDialog
            open={dialog === "claude"}
            onOpenChange={(o) => {
              if (!o) setDialog(null)
            }}
            onAdded={(account) => void handleAccountAdded("claude", account)}
          />
          <CodexAddAccountDialog
            open={dialog === "codex"}
            onOpenChange={(o) => {
              if (!o) setDialog(null)
            }}
            onAdded={(account) => void handleAccountAdded("codex", account)}
            initialMode="oauth"
          />
          <OpencodeAddAccountDialog
            open={dialog === "opencode"}
            onOpenChange={(o) => {
              if (!o) setDialog(null)
            }}
            onAdded={(account) => void handleAccountAdded("opencode", account)}
          />
        </>
      )}
    </div>
  )
}
