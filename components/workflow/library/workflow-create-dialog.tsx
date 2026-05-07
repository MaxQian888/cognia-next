"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { createWorkflow } from "@/lib/db/workflows"

export interface WorkflowCreateDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function WorkflowCreateDialog({ open, onOpenChange }: WorkflowCreateDialogProps) {
  const router = useRouter()
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [busy, setBusy] = useState(false)

  const handleCreate = async () => {
    if (busy) return
    setBusy(true)
    try {
      const wf = await createWorkflow({
        name: name.trim() || "Untitled workflow",
        description: description.trim() || undefined,
        nodes: [
          {
            id: "n_start",
            type: "trigger.manual",
            typeVersion: 1,
            position: { x: 80, y: 120 },
            data: { label: "Run manually", params: {} },
          },
        ],
        edges: [],
      })
      onOpenChange(false)
      setName("")
      setDescription("")
      toast.success("Workflow created")
      router.push(`/workflows/${wf.id}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create workflow")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New workflow</DialogTitle>
          <DialogDescription>
            Start with an empty graph plus a manual trigger you can connect to.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="wf-name">Name</Label>
            <Input
              id="wf-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Daily standup digest"
              autoFocus
              maxLength={120}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wf-desc">Description</Label>
            <Textarea
              id="wf-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional — what this workflow does and when it runs"
              rows={3}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={busy}>
            {busy ? "Creating…" : "Create workflow"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
