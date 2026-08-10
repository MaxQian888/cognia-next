"use client"

/**
 * NativeLogLevels - per-target level control for the Rust structured tracing
 * subscriber (`cognia-structured.log`). Tauri-only: renders nothing in the
 * browser/Capacitor shells where the native commands don't exist.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { Plus, Trash2, Server } from "lucide-react"
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
import { Separator } from "@/components/ui/separator"
import { isTauri } from "@/lib/tauri"
import {
  getTracingLevels,
  setTracingLevels,
  type TracingTargetLevel,
} from "@/lib/native/native-logging"

// tracing has five levels; the frontend's `fatal` maps to `error` natively.
const NATIVE_LEVELS = ["trace", "debug", "info", "warn", "error"] as const

export function NativeLogLevels() {
  const t = useTranslations("logging")
  const [available] = useState(() => isTauri())
  const [rules, setRules] = useState<TracingTargetLevel[]>([])
  const [defaultLevel, setDefaultLevel] = useState<string>("info")
  const [newRule, setNewRule] = useState<TracingTargetLevel>({ target: "", level: "debug" })
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle")

  useEffect(() => {
    if (!available) {
      return
    }
    let active = true
    void getTracingLevels().then((result) => {
      if (active && result) {
        setRules(result.rules)
        setDefaultLevel(result.defaultLevel)
      }
    })
    return () => {
      active = false
    }
  }, [available])

  const apply = useCallback(async () => {
    setStatus("saving")
    const result = await setTracingLevels(rules, defaultLevel)
    if (result) {
      setRules(result.rules)
      setDefaultLevel(result.defaultLevel)
      setStatus("saved")
    } else {
      setStatus("error")
    }
  }, [rules, defaultLevel])

  if (!available) {
    return null
  }

  const setRuleLevel = (target: string, level: string) => {
    setRules((prev) => prev.map((rule) => (rule.target === target ? { ...rule, level } : rule)))
  }
  const removeRule = (target: string) => {
    setRules((prev) => prev.filter((rule) => rule.target !== target))
  }
  const addRule = () => {
    const target = newRule.target.trim()
    if (!target) {
      return
    }
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

  return (
    <section className="border-y bg-background">
      <header className="border-b px-4 py-3">
        <h3 className="flex items-center gap-2 text-base font-medium">
          <Server className="h-4 w-4" />
          {t("settings.nativeLevels.title")}
        </h3>
        <p className="text-sm text-muted-foreground">{t("settings.nativeLevels.description")}</p>
      </header>
      <div className="flex flex-col gap-3 p-4">
        <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
          <Label className="sm:w-32 text-sm">{t("settings.nativeLevels.defaultLabel")}</Label>
          <Select value={defaultLevel} onValueChange={setDefaultLevel}>
            <SelectTrigger className="w-full sm:w-[130px]">
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

        <Separator />

        {sortedRules.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("settings.nativeLevels.empty")}</p>
        ) : (
          sortedRules.map((rule) => (
            <div key={rule.target} className="flex items-center gap-2">
              <span className="flex-1 min-w-0 truncate text-sm font-mono">{rule.target}</span>
              <Select
                value={rule.level}
                onValueChange={(value) => setRuleLevel(rule.target, value)}
              >
                <SelectTrigger className="w-[130px]">
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
                aria-label={t("settings.nativeLevels.removeAria", { module: rule.target })}
                onClick={() => removeRule(rule.target)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))
        )}

        <Separator />

        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex-1 space-y-1">
            <Label className="text-xs">{t("settings.nativeLevels.moduleLabel")}</Label>
            <Input
              // i18n-exempt: tracing target module example
              placeholder="network:lark"
              value={newRule.target}
              onChange={(e) => setNewRule((prev) => ({ ...prev, target: e.target.value }))}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t("settings.nativeLevels.levelLabel")}</Label>
            <Select
              value={newRule.level}
              onValueChange={(value) => setNewRule((prev) => ({ ...prev, level: value }))}
            >
              <SelectTrigger className="w-full sm:w-[130px]">
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
          <Button variant="outline" onClick={addRule} className="sm:self-end">
            <Plus className="h-4 w-4 mr-1" />
            {t("settings.nativeLevels.add")}
          </Button>
        </div>

        <div className="flex items-center justify-end gap-2">
          {status === "saved" ? (
            <span className="text-xs text-muted-foreground">
              {t("settings.nativeLevels.saved")}
            </span>
          ) : null}
          {status === "error" ? (
            <span className="text-xs text-destructive">{t("settings.nativeLevels.error")}</span>
          ) : null}
          <Button size="sm" onClick={apply} disabled={status === "saving"}>
            {t("settings.nativeLevels.apply")}
          </Button>
        </div>
      </div>
    </section>
  )
}
