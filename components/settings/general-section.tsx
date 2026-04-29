"use client"

import { useEffect, useState } from "react"
import { open as openDialog } from "@tauri-apps/plugin-dialog"
import { FolderOpenIcon, XIcon } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { isTauri } from "@/lib/tauri"
import type { AppSettings } from "@/lib/claude/types"
import { useSettingsStore } from "@/stores/settings-store"

const MODEL_PRESETS = [
  { value: "claude-opus-4-7", label: "Claude Opus 4.7" },
  { value: "claude-opus-4-5", label: "Claude Opus 4.5" },
  { value: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
  { value: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
]

const PERMISSION_MODES: NonNullable<AppSettings["permissionMode"]>[] = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
]

export function GeneralSection({ onClose }: { onClose: () => void }) {
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const toggle = useSettingsStore((s) => s.toggleAlwaysAllow)

  const [model, setModel] = useState<string>("")
  const [systemPrompt, setSystemPrompt] = useState<string>("")
  const [workingDir, setWorkingDir] = useState<string>("")
  const [permissionMode, setPermissionMode] =
    useState<NonNullable<AppSettings["permissionMode"]>>("default")

  useEffect(() => {
    if (!settings) return
    /* eslint-disable react-hooks/set-state-in-effect */
    setModel(settings.defaultModel ?? "")
    setSystemPrompt(settings.defaultSystemPrompt ?? "")
    setWorkingDir(settings.defaultWorkingDir ?? "")
    setPermissionMode(settings.permissionMode ?? "default")
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [settings])

  const handlePickDir = async () => {
    if (!isTauri()) return
    const picked = await openDialog({
      directory: true,
      multiple: false,
      title: "Select working directory",
    })
    if (typeof picked === "string") setWorkingDir(picked)
  }

  const handleSave = async () => {
    await save({
      defaultModel: model.trim() || undefined,
      defaultSystemPrompt: systemPrompt.trim() || undefined,
      defaultWorkingDir: workingDir.trim() || undefined,
      permissionMode,
    })
    toast.success("Settings saved.")
  }

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor="settings-model">Default model</Label>
        <Select value={model} onValueChange={setModel}>
          <SelectTrigger id="settings-model">
            <SelectValue placeholder="Use SDK default" />
          </SelectTrigger>
          <SelectContent>
            {MODEL_PRESETS.map((m) => (
              <SelectItem key={m.value} value={m.value}>
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          id="settings-model-custom"
          placeholder="Or paste a custom model id"
          value={model}
          onChange={(e) => setModel(e.target.value)}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="settings-workdir">Working directory</Label>
        <div className="flex gap-2">
          <Input
            id="settings-workdir"
            value={workingDir}
            onChange={(e) => setWorkingDir(e.target.value)}
            placeholder="/path/to/project"
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={handlePickDir}
            disabled={!isTauri()}
            aria-label="Pick directory"
          >
            <FolderOpenIcon className="size-4" />
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="settings-permission">Permission mode</Label>
        <Select
          value={permissionMode}
          onValueChange={(v) => setPermissionMode(v as NonNullable<AppSettings["permissionMode"]>)}
        >
          <SelectTrigger id="settings-permission">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PERMISSION_MODES.map((m) => (
              <SelectItem key={m} value={m}>
                {m}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Controls how the agent treats tool calls. Most users want{" "}
          <code className="rounded bg-muted px-1 py-0.5">default</code>.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="settings-system">Default system prompt</Label>
        <Textarea
          id="settings-system"
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          placeholder="Optional. Prepended to every conversation when a session has no override."
          rows={4}
        />
      </div>

      <div className="space-y-2">
        <Label>Always-allowed tools</Label>
        <div className="flex flex-wrap gap-1.5">
          {(settings?.alwaysAllowTools ?? []).length === 0 && (
            <p className="text-xs text-muted-foreground">
              None yet. Tools you mark &quot;Allow always&quot; in approval dialogs appear here.
            </p>
          )}
          {settings?.alwaysAllowTools?.map((tool) => (
            <Badge key={tool} variant="secondary" className="gap-1 pr-1.5 font-mono">
              {tool}
              <button
                type="button"
                onClick={() => void toggle(tool, false)}
                aria-label={`Remove ${tool} from always-allow list`}
                className="rounded-sm hover:bg-muted"
              >
                <XIcon className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={handleSave}>Save</Button>
      </div>
    </div>
  )
}
