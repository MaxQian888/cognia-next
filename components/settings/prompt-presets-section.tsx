"use client"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Card } from "@/components/ui/card"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { createPreset, deletePreset, listPresets, updatePreset } from "@/lib/db/prompt-presets"
import type { SystemPromptPreset } from "@/lib/claude/types"
import { useLiveQuery } from "dexie-react-hooks"
import { PencilIcon, PlusIcon, Trash2Icon } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"

export function PromptPresetsSection() {
  const presets = useLiveQuery(() => listPresets(), []) ?? []
  const [editing, setEditing] = useState<SystemPromptPreset | null>(null)
  const [creating, setCreating] = useState(false)

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <Label>System-prompt presets</Label>
          <p className="text-xs text-muted-foreground">
            Reusable system prompts you can apply per session.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setEditing(null)
            setCreating(true)
          }}
        >
          <PlusIcon className="mr-2 size-4" />
          New preset
        </Button>
      </div>

      {presets.length === 0 && !creating ? (
        <p className="rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
          No presets yet. Create one to switch between common system prompts.
        </p>
      ) : (
        <div className="space-y-2">
          {presets.map((p) => (
            <PresetRow
              key={p.id}
              preset={p}
              editing={editing?.id === p.id}
              onEditStart={() => setEditing(p)}
              onEditCancel={() => setEditing(null)}
              onEditSave={async (name, content) => {
                await updatePreset(p.id, { name, content })
                setEditing(null)
                toast.success("Preset updated.")
              }}
              onDelete={async () => {
                await deletePreset(p.id)
                toast.success(`Deleted "${p.name}".`)
              }}
            />
          ))}
        </div>
      )}

      {creating && (
        <PresetEditor
          initialName=""
          initialContent=""
          onCancel={() => setCreating(false)}
          onSave={async (name, content) => {
            await createPreset({ name, content })
            setCreating(false)
            toast.success("Preset created.")
          }}
        />
      )}
    </div>
  )
}

interface RowProps {
  preset: SystemPromptPreset
  editing: boolean
  onEditStart: () => void
  onEditCancel: () => void
  onEditSave: (name: string, content: string) => Promise<void>
  onDelete: () => Promise<void>
}

function PresetRow({ preset, editing, onEditStart, onEditCancel, onEditSave, onDelete }: RowProps) {
  if (editing) {
    return (
      <PresetEditor
        initialName={preset.name}
        initialContent={preset.content}
        onCancel={onEditCancel}
        onSave={onEditSave}
      />
    )
  }
  return (
    <Card className="p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{preset.name}</p>
          <p className="line-clamp-2 text-xs text-muted-foreground">
            {preset.content || "(empty)"}
          </p>
        </div>
        <div className="flex shrink-0 gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={onEditStart}
            aria-label={`Edit ${preset.name}`}
          >
            <PencilIcon className="size-3.5" />
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-destructive hover:text-destructive"
                aria-label={`Delete ${preset.name}`}
              >
                <Trash2Icon className="size-3.5" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete preset?</AlertDialogTitle>
                <AlertDialogDescription>
                  Sessions currently using &quot;{preset.name}&quot; will keep their copy of the
                  system prompt.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => void onDelete()}>Delete</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>
    </Card>
  )
}

interface EditorProps {
  initialName: string
  initialContent: string
  onCancel: () => void
  onSave: (name: string, content: string) => Promise<void>
}

function PresetEditor({ initialName, initialContent, onCancel, onSave }: EditorProps) {
  const [name, setName] = useState(initialName)
  const [content, setContent] = useState(initialContent)
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    if (!name.trim()) {
      toast.error("Preset name is required.")
      return
    }
    setSaving(true)
    try {
      await onSave(name.trim(), content)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card className="space-y-3 p-3">
      <Input
        placeholder="Preset name (e.g. Code Reviewer)"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <Textarea
        placeholder="System prompt content"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={6}
        className="font-mono text-xs"
      />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" onClick={submit} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </Card>
  )
}
