"use client"

import { useEffect, useState } from "react"
import { toast } from "sonner"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { useSettingsStore } from "@/stores/settings"
import { createLogger } from "@cognia/logging"

const log = createLogger("settings.subagentNesting")

const clampInt = (value: string, min: number, max: number, fallback: number): number => {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

/**
 * App-level config for nested subagent dispatch (depth-N). Opt-in: when off,
 * the chat agent keeps the SDK-native Task tool (depth 1) and nothing changes.
 * Self-contained card with its own save — mirrors InstructionsCard.
 */
export function SubagentNestingCard() {
  const t = useTranslations("settings.subagents.nesting")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)

  const [enabled, setEnabled] = useState(false)
  const [maxDepth, setMaxDepth] = useState(2)
  const [tokenBudget, setTokenBudget] = useState(0)
  const [timeoutSeconds, setTimeoutSeconds] = useState(0)
  const [dispatchMaxRetries, setDispatchMaxRetries] = useState(1)

  useEffect(() => {
    const cfg = settings?.subagentNesting
    if (!cfg) return
    /* eslint-disable react-hooks/set-state-in-effect */
    setEnabled(cfg.enabled ?? false)
    setMaxDepth(cfg.maxDepth ?? 2)
    setTokenBudget(cfg.tokenBudget ?? 0)
    setTimeoutSeconds(cfg.timeoutMs ? Math.round(cfg.timeoutMs / 1000) : 0)
    setDispatchMaxRetries(cfg.dispatchMaxRetries ?? 1)
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [settings])

  const handleSave = async () => {
    try {
      await save({
        subagentNesting: {
          enabled,
          maxDepth,
          tokenBudget: tokenBudget > 0 ? tokenBudget : 0,
          timeoutMs: timeoutSeconds > 0 ? timeoutSeconds * 1000 : 0,
          dispatchMaxRetries,
        },
      })
      log.info("subagentNesting.saved", {
        enabled,
        maxDepth,
        tokenBudget,
        timeoutSeconds,
        dispatchMaxRetries,
      })
      toast.success(t("saved"))
    } catch (err) {
      log.error("subagentNesting.saveFailed", err)
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="space-y-4" data-setting-id="subagent-nesting">
      <div className="space-y-0.5">
        <Label className="text-sm font-medium">{t("title")}</Label>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>

      <div className="flex items-center justify-between gap-4">
        <div className="space-y-0.5">
          <Label htmlFor="settings-subagent-nesting-enabled" className="text-sm">
            {t("enabled")}
          </Label>
          <p className="text-xs text-muted-foreground">{t("enabledHint")}</p>
        </div>
        <Switch
          id="settings-subagent-nesting-enabled"
          checked={enabled}
          onCheckedChange={setEnabled}
          aria-label={t("enabled")}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="settings-subagent-nesting-depth">{t("maxDepth")}</Label>
        <Input
          id="settings-subagent-nesting-depth"
          type="number"
          min={1}
          max={5}
          value={maxDepth}
          onChange={(e) => setMaxDepth(clampInt(e.target.value, 1, 5, 2))}
          disabled={!enabled}
          aria-label={t("maxDepth")}
        />
        <p className="text-xs text-muted-foreground">{t("maxDepthHint")}</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="settings-subagent-nesting-budget">{t("tokenBudget")}</Label>
        <Input
          id="settings-subagent-nesting-budget"
          type="number"
          min={0}
          step={1000}
          value={tokenBudget}
          onChange={(e) => setTokenBudget(clampInt(e.target.value, 0, 100_000_000, 0))}
          disabled={!enabled}
          aria-label={t("tokenBudget")}
        />
        <p className="text-xs text-muted-foreground">{t("tokenBudgetHint")}</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="settings-subagent-nesting-timeout">{t("timeout")}</Label>
        <Input
          id="settings-subagent-nesting-timeout"
          type="number"
          min={0}
          step={10}
          value={timeoutSeconds}
          onChange={(e) => setTimeoutSeconds(clampInt(e.target.value, 0, 86_400, 0))}
          disabled={!enabled}
          aria-label={t("timeout")}
        />
        <p className="text-xs text-muted-foreground">{t("timeoutHint")}</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="settings-subagent-dispatch-retries">{t("dispatchMaxRetries")}</Label>
        <Input
          id="settings-subagent-dispatch-retries"
          type="number"
          min={0}
          max={5}
          value={dispatchMaxRetries}
          onChange={(e) => setDispatchMaxRetries(clampInt(e.target.value, 0, 5, 1))}
          aria-label={t("dispatchMaxRetries")}
        />
        <p className="text-xs text-muted-foreground">{t("dispatchMaxRetriesHint")}</p>
      </div>

      <div className="flex justify-end">
        <Button size="sm" onClick={handleSave}>
          {t("save")}
        </Button>
      </div>
    </div>
  )
}
