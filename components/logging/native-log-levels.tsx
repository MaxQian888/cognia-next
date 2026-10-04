"use client"

/**
 * NativeLogLevels - per-target level control for the Rust structured tracing
 * subscriber (`cognia-structured.log`). Tauri-only: renders nothing in the
 * browser/Capacitor shells where the native commands don't exist.
 *
 * The form only claims what it knows. Apply used to be live before the
 * current levels had loaded — and when the read failed it stayed live over
 * the placeholder defaults, so one click overwrote the user's real
 * overrides with "info, no rules". Now a failed read says so (with a retry),
 * Apply waits for a successful read, and it is enabled only while the form
 * differs from what the subscriber last reported. "Applied" describes the
 * state that was applied, so the first edit after it clears the badge.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { Plus, Trash2, Server, RefreshCw } from "lucide-react"
import { SettingsBlock, SettingsField } from "@/components/settings/common/settings-block"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { isTauri } from "@/lib/tauri"
import {
  getTracingLevels,
  setTracingLevels,
  type TracingTargetLevel,
} from "@/lib/native/native-logging"

// tracing has five levels; the frontend's `fatal` maps to `error` natively.
const NATIVE_LEVELS = ["trace", "debug", "info", "warn", "error"] as const

interface LevelsSnapshot {
  rules: TracingTargetLevel[]
  defaultLevel: string
}

/** Order-insensitive identity of a level set — what "dirty" is measured against. */
function snapshotKey(snapshot: LevelsSnapshot): string {
  const rules = [...snapshot.rules]
    .sort((a, b) => a.target.localeCompare(b.target))
    .map((rule) => `${rule.target}=${rule.level}`)
  return `${snapshot.defaultLevel}|${rules.join(",")}`
}

type LoadState = "loading" | "loaded" | "error"
type SaveStatus = "idle" | "saving" | "saved" | "error"

export function NativeLogLevels() {
  const t = useTranslations("logging")
  const [available] = useState(() => isTauri())
  const [rules, setRules] = useState<TracingTargetLevel[]>([])
  const [defaultLevel, setDefaultLevel] = useState<string>("info")
  const [newRule, setNewRule] = useState<TracingTargetLevel>({ target: "", level: "debug" })
  const [status, setStatus] = useState<SaveStatus>("idle")
  const [loadState, setLoadState] = useState<LoadState>("loading")
  // What the subscriber last reported (load or apply); the form is dirty
  // while it differs from this.
  const [baseline, setBaseline] = useState<LevelsSnapshot | null>(null)
  const [loadAttempt, setLoadAttempt] = useState(0)

  useEffect(() => {
    if (!available) {
      return
    }
    let active = true
    void getTracingLevels().then((result) => {
      if (!active) return
      if (result) {
        setRules(result.rules)
        setDefaultLevel(result.defaultLevel)
        setBaseline({ rules: result.rules, defaultLevel: result.defaultLevel })
        setLoadState("loaded")
      } else {
        setLoadState("error")
      }
    })
    return () => {
      active = false
    }
  }, [available, loadAttempt])

  const retryLoad = useCallback(() => {
    setLoadState("loading")
    setLoadAttempt((n) => n + 1)
  }, [])

  const dirty = useMemo(
    () => baseline !== null && snapshotKey({ rules, defaultLevel }) !== snapshotKey(baseline),
    [baseline, rules, defaultLevel]
  )

  const apply = useCallback(async () => {
    setStatus("saving")
    const result = await setTracingLevels(rules, defaultLevel)
    if (result) {
      setRules(result.rules)
      setDefaultLevel(result.defaultLevel)
      setBaseline({ rules: result.rules, defaultLevel: result.defaultLevel })
      setStatus("saved")
    } else {
      setStatus("error")
    }
  }, [rules, defaultLevel])

  if (!available) {
    return null
  }

  // Any edit makes "Applied" / "Failed to apply" describe a state that is no
  // longer on screen.
  const touch = () => {
    setStatus((prev) => (prev === "saved" || prev === "error" ? "idle" : prev))
  }
  const changeDefaultLevel = (level: string) => {
    touch()
    setDefaultLevel(level)
  }
  const setRuleLevel = (target: string, level: string) => {
    touch()
    setRules((prev) => prev.map((rule) => (rule.target === target ? { ...rule, level } : rule)))
  }
  const removeRule = (target: string) => {
    touch()
    setRules((prev) => prev.filter((rule) => rule.target !== target))
  }
  const addRule = () => {
    const target = newRule.target.trim()
    if (!target) {
      return
    }
    touch()
    setRules((prev) => {
      const existing = prev.find((rule) => rule.target === target)
      if (existing) {
        return prev.map((rule) =>
          rule.target === target ? { ...rule, level: newRule.level } : rule
        )
      }
      return [...prev, { target, level: newRule.level }]
    })
    setNewRule({ target: "", level: "debug" })
  }

  const sortedRules = [...rules].sort((a, b) => a.target.localeCompare(b.target))
  const loaded = loadState === "loaded"

  return (
    <SettingsBlock
      icon={<Server />}
      title={t("settings.nativeLevels.title")}
      description={t("settings.nativeLevels.description")}
      testid="native-log-levels"
      action={
        <div className="flex items-center gap-2">
          {status === "saved" ? (
            <span className="text-xs text-muted-foreground">
              {t("settings.nativeLevels.saved")}
            </span>
          ) : null}
          {status === "error" ? (
            <span className="text-xs text-destructive">{t("settings.nativeLevels.error")}</span>
          ) : null}
          {loaded && dirty && status === "idle" ? (
            <span className="text-xs text-muted-foreground" data-testid="native-log-levels-dirty">
              {t("settings.nativeLevels.unsaved")}
            </span>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            onClick={apply}
            disabled={!loaded || !dirty || status === "saving"}
          >
            {t("settings.nativeLevels.apply")}
          </Button>
        </div>
      }
    >
      {loadState === "error" ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 text-xs text-destructive"
          data-testid="native-log-levels-load-error"
        >
          <span>{t("settings.nativeLevels.loadError")}</span>
          <Button size="sm" variant="outline" className="h-7" onClick={retryLoad}>
            <RefreshCw className="mr-1 h-3.5 w-3.5" aria-hidden />
            {t("settings.nativeLevels.retry")}
          </Button>
        </div>
      ) : null}
      {loadState === "loading" ? (
        <p role="status" className="text-xs text-muted-foreground">
          {t("settings.nativeLevels.loading")}
        </p>
      ) : null}
      <SettingsField
        htmlFor="native-log-default-level"
        label={t("settings.nativeLevels.defaultLabel")}
      >
        <Select value={defaultLevel} onValueChange={changeDefaultLevel} disabled={!loaded}>
          <SelectTrigger id="native-log-default-level" className="w-[130px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {NATIVE_LEVELS.map((level) => (
                <SelectItem key={level} value={level}>
                  <span className="capitalize">{t(`settings.logLevel.${level}`)}</span>
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </SettingsField>

      {!loaded ? null : sortedRules.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("settings.nativeLevels.empty")}</p>
      ) : (
        <ul className="divide-y divide-border/60 rounded-lg border">
          {sortedRules.map((rule) => (
            <li key={rule.target} className="flex items-center gap-2 px-3 py-2">
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{rule.target}</span>
              <Select
                value={rule.level}
                onValueChange={(value) => setRuleLevel(rule.target, value)}
              >
                <SelectTrigger className="h-8 w-[130px]" aria-label={rule.target}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {NATIVE_LEVELS.map((level) => (
                      <SelectItem key={level} value={level}>
                        <span className="capitalize">{t(`settings.logLevel.${level}`)}</span>
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <Button
                variant="ghost"
                size="icon"
                className="size-8 shrink-0"
                aria-label={t("settings.nativeLevels.removeAria", { module: rule.target })}
                onClick={() => removeRule(rule.target)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-col gap-2 rounded-lg border border-dashed p-3 @md/settings-stack:flex-row @md/settings-stack:items-end">
        <div className="min-w-0 flex-1 space-y-1.5">
          <Label htmlFor="native-log-new-target" className="text-xs">
            {t("settings.nativeLevels.moduleLabel")}
          </Label>
          <Input
            id="native-log-new-target"
            // i18n-exempt: tracing target module example
            placeholder="network:lark"
            value={newRule.target}
            onChange={(e) => setNewRule((prev) => ({ ...prev, target: e.target.value }))}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="native-log-new-level" className="text-xs">
            {t("settings.nativeLevels.levelLabel")}
          </Label>
          <Select
            value={newRule.level}
            onValueChange={(value) => setNewRule((prev) => ({ ...prev, level: value }))}
          >
            <SelectTrigger
              id="native-log-new-level"
              className="w-full @md/settings-stack:w-[130px]"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {NATIVE_LEVELS.map((level) => (
                  <SelectItem key={level} value={level}>
                    <span className="capitalize">{t(`settings.logLevel.${level}`)}</span>
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
        <Button variant="outline" onClick={addRule} disabled={!loaded || !newRule.target.trim()}>
          <Plus className="h-4 w-4 mr-1" />
          {t("settings.nativeLevels.add")}
        </Button>
      </div>
    </SettingsBlock>
  )
}
