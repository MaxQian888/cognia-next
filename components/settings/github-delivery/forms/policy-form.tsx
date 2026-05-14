"use client"

/**
 * Reusable GhPolicy editor. Used by:
 *   - The Policies tab as the editor for `AppSettings.githubDelivery.defaultPolicy`.
 *   - The per-repo override Drawer rendered by the same tab.
 *
 * The form keeps state local — the caller decides where to persist via the
 * `onSave` callback. `value === null` means "no policy configured yet" and
 * the form seeds itself from `DEFAULT_GH_POLICY`. Per-repo Drawers pass the
 * existing override or null; the global form always passes a full value.
 */

import { useEffect, useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  DEFAULT_GH_POLICY,
  type AllowedAuthors,
  type GhPolicy,
  type QuietHoursWindow,
} from "@/lib/github/types"

export interface PolicyFormProps {
  value: GhPolicy | null
  onSave: (next: GhPolicy) => Promise<void> | void
  onReset?: () => Promise<void> | void
  /** When true, "Reset to global" is rendered. The Drawer turns this on. */
  showResetToGlobal?: boolean
  /** Disable the inputs (e.g., while a save IPC is in flight). */
  disabled?: boolean
}

export function PolicyForm({
  value,
  onSave,
  onReset,
  showResetToGlobal = false,
  disabled,
}: PolicyFormProps) {
  const [draft, setDraft] = useState<GhPolicy>(value ?? DEFAULT_GH_POLICY)
  const [busy, setBusy] = useState(false)
  const [diff, setDiff] = useState<string | null>(null)

  useEffect(() => {
    // Sync the form when the upstream value changes (e.g., the Drawer is
    // reopened against a different repo). Cascading-render warning suppressed
    // because the new draft is stable across re-renders unless `value` itself
    // changes — React batches the set into the same commit.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDraft(value ?? DEFAULT_GH_POLICY)
  }, [value])

  const dirty = useMemo(
    () => stableStringify(draft) !== stableStringify(value ?? DEFAULT_GH_POLICY),
    [draft, value]
  )

  const handleSave = async () => {
    setBusy(true)
    try {
      const before = stableStringify(value ?? DEFAULT_GH_POLICY)
      const after = stableStringify(draft)
      setDiff(computeDiff(before, after))
      await onSave(draft)
    } finally {
      setBusy(false)
    }
  }

  const handleReset = async () => {
    setBusy(true)
    try {
      await onReset?.()
      setDraft(value ?? DEFAULT_GH_POLICY)
      setDiff(null)
    } finally {
      setBusy(false)
    }
  }

  const branchRegexText = draft.branchProtection.join("\n")
  const allowedAuthorsKind = draft.allowedAuthors.kind

  return (
    <div className="space-y-4" data-testid="policy-form">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="flex items-center justify-between rounded-md border p-3">
          <div>
            <Label className="text-sm font-medium">Require green CI</Label>
            <p className="text-xs text-muted-foreground">Block merge until CI passes.</p>
          </div>
          <Switch
            checked={draft.requireGreenCi}
            disabled={disabled || busy}
            onCheckedChange={(checked) =>
              setDraft((d) => ({ ...d, requireGreenCi: Boolean(checked) }))
            }
            aria-label="Require green CI"
          />
        </div>
        <div className="flex items-center justify-between rounded-md border p-3">
          <div>
            <Label className="text-sm font-medium">Require human approval</Label>
            <p className="text-xs text-muted-foreground">Send to Inbox for ✅ before acting.</p>
          </div>
          <Switch
            checked={draft.requireHumanApproval}
            disabled={disabled || busy}
            onCheckedChange={(checked) =>
              setDraft((d) => ({ ...d, requireHumanApproval: Boolean(checked) }))
            }
            aria-label="Require human approval"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label htmlFor="max-daily-merges">Max daily merges</Label>
          <Input
            id="max-daily-merges"
            type="number"
            min={0}
            value={draft.maxDailyMerges}
            disabled={disabled || busy}
            onChange={(e) =>
              setDraft((d) => ({
                ...d,
                maxDailyMerges: Math.max(0, Number(e.target.value) || 0),
              }))
            }
          />
          <p className="text-xs text-muted-foreground">
            Hard cap on bot-driven merges per UTC day. 0 disables auto-merges entirely.
          </p>
        </div>

        <div className="space-y-2">
          <Label>Allowed authors</Label>
          <Select
            value={allowedAuthorsKind}
            disabled={disabled || busy}
            onValueChange={(v) =>
              setDraft((d) => ({
                ...d,
                allowedAuthors:
                  v === "explicit"
                    ? ({
                        kind: "explicit",
                        logins: explicitLogins(d.allowedAuthors),
                      } as AllowedAuthors)
                    : ({ kind: v as "collaborators" | "members" } as AllowedAuthors),
              }))
            }
          >
            <SelectTrigger aria-label="allowed-authors">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="collaborators">collaborators</SelectItem>
              <SelectItem value="members">members</SelectItem>
              <SelectItem value="explicit">explicit logins</SelectItem>
            </SelectContent>
          </Select>
          {allowedAuthorsKind === "explicit" && (
            <Textarea
              rows={3}
              placeholder="one login per line"
              value={explicitLogins(draft.allowedAuthors).join("\n")}
              disabled={disabled || busy}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  allowedAuthors: {
                    kind: "explicit",
                    logins: e.target.value
                      .split(/\r?\n/)
                      .map((s) => s.trim())
                      .filter(Boolean),
                  },
                }))
              }
              aria-label="explicit-logins"
              className="font-mono text-xs"
            />
          )}
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="branch-regex">Protected branches (regex, one per line)</Label>
        <Textarea
          id="branch-regex"
          rows={3}
          value={branchRegexText}
          disabled={disabled || busy}
          onChange={(e) =>
            setDraft((d) => ({
              ...d,
              branchProtection: e.target.value
                .split(/\r?\n/)
                .map((s) => s.trim())
                .filter(Boolean),
            }))
          }
          aria-label="branch-protection"
          className="font-mono text-xs"
        />
      </div>

      <Card className="p-3 space-y-3">
        <div className="flex items-center justify-between">
          <Label className="text-sm font-medium">Quiet hours</Label>
          <Switch
            checked={!!draft.quietHours}
            disabled={disabled || busy}
            onCheckedChange={(checked) =>
              setDraft((d) => ({
                ...d,
                quietHours: checked ? (d.quietHours ?? defaultQuietHours()) : undefined,
              }))
            }
            aria-label="quiet-hours-enabled"
          />
        </div>
        {draft.quietHours && (
          <div className="grid grid-cols-3 gap-2">
            <div className="space-y-1">
              <Label htmlFor="quiet-from" className="text-xs">
                From (HH:MM)
              </Label>
              <Input
                id="quiet-from"
                value={draft.quietHours.from}
                disabled={disabled || busy}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    quietHours: applyQuiet(d.quietHours, { from: e.target.value }),
                  }))
                }
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="quiet-to" className="text-xs">
                To (HH:MM)
              </Label>
              <Input
                id="quiet-to"
                value={draft.quietHours.to}
                disabled={disabled || busy}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    quietHours: applyQuiet(d.quietHours, { to: e.target.value }),
                  }))
                }
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="quiet-tz" className="text-xs">
                Timezone
              </Label>
              <Input
                id="quiet-tz"
                value={draft.quietHours.tz}
                disabled={disabled || busy}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    quietHours: applyQuiet(d.quietHours, { tz: e.target.value }),
                  }))
                }
                placeholder="Asia/Shanghai"
              />
            </div>
          </div>
        )}
      </Card>

      {diff && (
        <Card className="p-3 space-y-1 border-emerald-400/40 bg-emerald-500/5">
          <Label className="text-xs font-medium">Saved — diff preview</Label>
          <pre className="text-xs overflow-x-auto font-mono whitespace-pre-wrap">{diff}</pre>
        </Card>
      )}

      <div className="flex gap-2">
        <Button
          onClick={handleSave}
          disabled={disabled || busy || !dirty}
          data-testid="policy-save"
        >
          Save policy
        </Button>
        {showResetToGlobal && onReset && (
          <Button
            type="button"
            variant="outline"
            disabled={disabled || busy}
            onClick={handleReset}
            data-testid="policy-reset"
          >
            Reset to global default
          </Button>
        )}
      </div>
    </div>
  )
}

function explicitLogins(authors: AllowedAuthors): string[] {
  return authors.kind === "explicit" ? authors.logins : []
}

function defaultQuietHours(): QuietHoursWindow {
  return { from: "22:00", to: "08:00", tz: "UTC" }
}

function applyQuiet(
  current: QuietHoursWindow | undefined,
  patch: Partial<QuietHoursWindow>
): QuietHoursWindow {
  const base = current ?? defaultQuietHours()
  return { ...base, ...patch }
}

/** Deterministic key-sorted JSON for diff + dirty detection. */
function stableStringify(value: unknown): string {
  return JSON.stringify(
    value,
    (_k, v) => {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const sorted: Record<string, unknown> = {}
        for (const k of Object.keys(v as Record<string, unknown>).sort()) {
          sorted[k] = (v as Record<string, unknown>)[k]
        }
        return sorted
      }
      return v
    },
    2
  )
}

function computeDiff(before: string, after: string): string {
  const beforeLines = before.split("\n")
  const afterLines = after.split("\n")
  const out: string[] = []
  const max = Math.max(beforeLines.length, afterLines.length)
  for (let i = 0; i < max; i++) {
    const b = beforeLines[i]
    const a = afterLines[i]
    if (b === a) {
      out.push(`  ${a ?? ""}`)
    } else {
      if (b !== undefined) out.push(`- ${b}`)
      if (a !== undefined) out.push(`+ ${a}`)
    }
  }
  return out.join("\n")
}
