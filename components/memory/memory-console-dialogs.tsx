"use client"

/**
 * The dialogs both `/memory` layouts share — add, move, conflict resolution and
 * the one delete confirmation — driven by `useMemoryConsole` state. Its own
 * module so the compact body can mount them without importing the wide
 * console.
 */

import { AddMemoryDialog } from "@/components/memory/add-memory-dialog"
import { MemoryConflictResolver } from "@/components/memory/memory-conflict-resolver"
import { MemoryDeleteConfirm } from "@/components/memory/memory-delete-confirm"
import { MemoryMoveDialog } from "@/components/memory/memory-move-dialog"
import type { MemoryConsoleState } from "@/hooks/memory/use-memory-console"

export function MemoryConsoleDialogs({ state }: { state: MemoryConsoleState }) {
  const { selectedMemory, conflictPartner } = state
  return (
    <>
      <AddMemoryDialog
        open={state.addOpen}
        onOpenChange={state.setAddOpen}
        onCreate={state.create}
      />
      <MemoryMoveDialog
        memory={state.moveMemory}
        onOpenChange={(open) => {
          if (!open) state.setMoveId(null)
        }}
        onMove={state.relocate}
      />
      {selectedMemory && conflictPartner ? (
        <MemoryConflictResolver
          // The merge draft seeds from `memory.text` at mount; keyed so moving
          // to another conflicting memory cannot merge the previous one's text.
          key={selectedMemory.id}
          open={state.resolverOpen}
          onOpenChange={state.setResolverOpen}
          memory={selectedMemory}
          resolveMemory={state.resolveMemory}
          onResolved={(keptId) => state.open(keptId)}
        />
      ) : null}
      <MemoryDeleteConfirm
        ids={state.pendingDelete}
        onCancel={() => state.setPendingDelete(null)}
        onConfirm={() => void state.confirmDelete()}
      />
    </>
  )
}
