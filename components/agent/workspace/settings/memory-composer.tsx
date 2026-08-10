"use client"

/**
 * Shared-memory entry composer (create / edit). Operators author entries
 * directly; the orchestrator's `publishEntry` enforces the PII gate and
 * version bump. Writes are attributed to the operator identity.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { useShallow } from "zustand/react/shallow"
import { CalendarIcon, XIcon } from "lucide-react"

import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { selectActiveTeammates } from "@/stores/agent/agent-team-store/selectors"
import {
  publishEntry,
  SharedMemoryPiiError,
  OPERATOR_READER_ID,
} from "@/lib/ai/agent/team/shared-memory-orchestrator"
import type { AgentTeam, SharedMemoryEntry } from "@/types/agent/agent-team"
import { markSettingsSaved } from "./settings-save-indicator"

export interface MemoryComposerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  team: AgentTeam
  mode: "create" | "edit"
  initial?: SharedMemoryEntry
}

export function MemoryComposer({ open, onOpenChange, team, mode, initial }: MemoryComposerProps) {
  const t = useTranslations("agentTeamsWorkspace.settings.memory.composer")
  const teammates = useAgentTeamStore(useShallow(selectActiveTeammates))

  const [key, setKey] = useState("")
  const [value, setValue] = useState("")
  const [asJson, setAsJson] = useState(false)
  const [tags, setTags] = useState<string[]>([])
  const [tagDraft, setTagDraft] = useState("")
  const [expiresAt, setExpiresAt] = useState<Date | undefined>(undefined)
  const [readableBy, setReadableBy] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)

  // Seed the form each time the dialog transitions to open. This is the
  // adjust-state-during-render pattern (react.dev "You Might Not Need an
  // Effect") — synchronously seeding here avoids the cascading re-render that
  // a setState-in-effect would trigger.
  const [wasOpen, setWasOpen] = useState(false)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setKey(initial?.key ?? "")
      const v = initial?.value
      if (typeof v === "string") {
        setValue(v)
        setAsJson(false)
      } else if (v !== undefined) {
        setValue(JSON.stringify(v, null, 2))
        setAsJson(true)
      } else {
        setValue("")
        setAsJson(false)
      }
      setTags(initial?.tags ?? [])
      setExpiresAt(initial?.expiresAt ? new Date(initial.expiresAt) : undefined)
      setReadableBy(initial?.readableBy ?? [])
      setError(null)
      setTagDraft("")
    }
  }

  const jsonValid = useMemo(() => {
    if (!asJson) return true
    try {
      JSON.parse(value)
      return true
    } catch {
      return false
    }
  }, [asJson, value])

  const addTag = () => {
    const tag = tagDraft.trim()
    if (tag && !tags.includes(tag)) setTags([...tags, tag])
    setTagDraft("")
  }

  const toggleReader = (id: string, next: boolean) => {
    setReadableBy((prev) => (next ? [...prev, id] : prev.filter((x) => x !== id)))
  }

  const handleSubmit = () => {
    setError(null)
    if (asJson && !jsonValid) {
      setError(t("invalidJson"))
      return
    }
    const parsedValue: unknown = asJson ? JSON.parse(value) : value
    try {
      publishEntry({
        teamId: team.id,
        key: key.trim(),
        value: parsedValue,
        writer: { id: OPERATOR_READER_ID, name: "Operator" },
        tags: tags.length > 0 ? tags : undefined,
        expiresAt,
        readableBy: readableBy.length > 0 ? readableBy : undefined,
      })
      markSettingsSaved()
      onOpenChange(false)
    } catch (err) {
      if (err instanceof SharedMemoryPiiError) {
        setError(t("piiBlocked"))
        return
      }
      throw err
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{mode === "edit" ? t("titleEdit") : t("titleCreate")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs">{t("key")}</Label>
            <Input
              value={key}
              onChange={(e) => setKey(e.target.value)}
              disabled={mode === "edit"}
              className="h-8 text-xs"
              data-testid="memory-key"
            />
          </div>
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <Label className="text-xs">{t("value")}</Label>
              <label className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <Switch checked={asJson} onCheckedChange={setAsJson} />
                {t("parseJson")}
              </label>
            </div>
            <Textarea
              rows={4}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="font-mono text-xs"
              data-testid="memory-value"
            />
            {asJson && !jsonValid ? (
              <p className="text-[10px] text-destructive">{t("invalidJson")}</p>
            ) : null}
          </div>

          {/* Tags */}
          <div className="space-y-1">
            <Label className="text-xs">{t("tags")}</Label>
            <div className="flex flex-wrap gap-1">
              {tags.map((tag) => (
                <Badge key={tag} variant="secondary" className="gap-1 font-mono text-[10px]">
                  {tag}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t("removeTag", { tag })}
                    onClick={() => setTags(tags.filter((x) => x !== tag))}
                  >
                    <XIcon className="size-2.5" />
                  </Button>
                </Badge>
              ))}
            </div>
            <Input
              value={tagDraft}
              onChange={(e) => setTagDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  addTag()
                }
              }}
              placeholder={t("tagsPlaceholder")}
              className="h-8 text-xs"
            />
          </div>

          {/* Expiry */}
          <div className="space-y-1">
            <Label className="text-xs">{t("expiresAt")}</Label>
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="h-8 w-full justify-start text-xs">
                  <CalendarIcon className="mr-2 size-3.5" />
                  {expiresAt ? expiresAt.toLocaleDateString() : "—"}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0">
                <Calendar mode="single" selected={expiresAt} onSelect={setExpiresAt} />
              </PopoverContent>
            </Popover>
          </div>

          {/* Readable-by ACL */}
          <div className="space-y-1">
            <Label className="text-xs">{t("readableBy")}</Label>
            {teammates.length === 0 ? (
              <p className="text-[10px] text-muted-foreground">{t("readableByAll")}</p>
            ) : (
              <div className="space-y-1">
                <p className="text-[10px] text-muted-foreground">{t("readableByAll")}</p>
                {teammates.map((tm) => (
                  <label key={tm.id} className="flex items-center gap-2 text-xs">
                    <Checkbox
                      checked={readableBy.includes(tm.id)}
                      onCheckedChange={(v) => toggleReader(tm.id, v === true)}
                    />
                    {tm.name}
                  </label>
                ))}
              </div>
            )}
          </div>

          {error ? (
            <Alert variant="destructive">
              <AlertDescription className="text-xs">{error}</AlertDescription>
            </Alert>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button size="sm" onClick={handleSubmit} disabled={!key.trim()}>
            {t("submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
