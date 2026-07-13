"use client"

// Prompt-enhancement toolbar action for the composer. A Wand button opens a
// menu of rewrite modes (improve / concise / detailed / technical / simpler /
// variants); picking one sends the current draft through `enhancePrompt`
// (renderer utility LLM client + PII gate) and shows the result in a preview
// dialog the user can apply or dismiss. This is the UI that activates the
// otherwise-dormant query-expansion engine (see `lib/chat/completion/enhance`).

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import { Loader2Icon, WandSparklesIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { buildUtilityLlmClient } from "@/lib/ai/generation/utility-client"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { enhancePrompt, ENHANCE_MODES, type EnhanceMode } from "@/lib/chat/completion/enhance"
import type { ChatSession } from "@cognia/agent-config-types"
import { cn } from "@/lib/utils"

interface EnhanceButtonProps {
  /** Current draft value. */
  value: string
  /** Apply the chosen rewrite / variant back into the composer. */
  onApply: (next: string) => void
  session: ChatSession | null | undefined
  disabled?: boolean
}

type Preview =
  | { kind: "rewrite"; original: string; text: string }
  | { kind: "variants"; variants: string[] }
  | null

export function EnhanceButton({ value, onApply, session, disabled }: EnhanceButtonProps) {
  const t = useTranslations("chat.composer.enhance")
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<Preview>(null)

  const run = useCallback(
    async (mode: EnhanceMode) => {
      if (busy) return
      const appSettings = useSettingsStore.getState().settings
      const client = buildUtilityLlmClient({
        session: session ?? null,
        appSettings,
        override: appSettings?.composerAssistance?.model,
        featureId: "composer-enhance",
      })
      if (!client) {
        toast.error(t("toast.noModel"))
        return
      }
      setBusy(true)
      try {
        const result = await enhancePrompt(value, mode, { client })
        if (result.kind === "rewrite") {
          setPreview({ kind: "rewrite", original: value, text: result.text })
        } else if (result.kind === "variants") {
          setPreview({ kind: "variants", variants: result.variants })
        } else {
          const reason =
            result.reason === "pii"
              ? t("toast.pii")
              : result.reason === "empty"
                ? t("toast.empty")
                : t("toast.noOutput")
          toast.info(reason)
        }
      } catch {
        toast.error(t("toast.error"))
      } finally {
        setBusy(false)
      }
    },
    [busy, session, value, t]
  )

  const apply = useCallback(
    (next: string) => {
      onApply(next)
      setPreview(null)
      toast.success(t("toast.applied"))
    },
    [onApply, t]
  )

  return (
    <>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-7"
                disabled={disabled || busy}
                aria-label={t("trigger")}
                data-testid="composer-enhance-trigger"
              >
                {busy ? (
                  <Loader2Icon className="size-3.5 animate-spin" />
                ) : (
                  <WandSparklesIcon className="size-3.5" />
                )}
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>{t("trigger")}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="start" className="w-44">
          {ENHANCE_MODES.map((mode) => (
            <DropdownMenuItem key={mode} onSelect={() => void run(mode)}>
              {t(`modes.${mode}` as `modes.${EnhanceMode}`)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={preview !== null} onOpenChange={(open) => !open && setPreview(null)}>
        <DialogContent className="max-w-lg">
          {preview?.kind === "rewrite" ? (
            <>
              <DialogHeader>
                <DialogTitle>{t("preview.title")}</DialogTitle>
              </DialogHeader>
              <div className="space-y-3 text-sm">
                <div className="space-y-1">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {t("preview.original")}
                  </p>
                  <p className="max-h-32 overflow-y-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-2 text-muted-foreground">
                    {preview.original}
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {t("preview.enhanced")}
                  </p>
                  <p className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md border border-primary/30 bg-primary/5 p-2">
                    {preview.text}
                  </p>
                </div>
              </div>
              <DialogFooter>
                <Button variant="ghost" onClick={() => setPreview(null)}>
                  {t("preview.cancel")}
                </Button>
                <Button onClick={() => apply(preview.text)}>{t("preview.apply")}</Button>
              </DialogFooter>
            </>
          ) : preview?.kind === "variants" ? (
            <>
              <DialogHeader>
                <DialogTitle>{t("preview.variantsTitle")}</DialogTitle>
              </DialogHeader>
              <div className="space-y-2">
                {preview.variants.map((variant, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => apply(variant)}
                    className={cn(
                      "block w-full rounded-md border p-2 text-left text-sm",
                      "transition-colors hover:border-primary/30 hover:bg-accent",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    )}
                  >
                    {variant}
                  </button>
                ))}
              </div>
              <DialogFooter>
                <Button variant="ghost" onClick={() => setPreview(null)}>
                  {t("preview.cancel")}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  )
}
