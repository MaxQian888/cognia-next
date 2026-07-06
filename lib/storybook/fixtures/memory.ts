// Storybook-only fixtures for the long-term memory subsystem
// (`components/memory/**`). Dependency-free (types only) so importing it never
// drags a store or Dexie.
import type { Memory, MemoryType } from "@/types/memory/memory"

/** Fixed clock so "accessed x ago" labels render deterministically-ish. */
export const MEMORY_NOW = 1_700_000_000_000

export function makeMemory(over: Partial<Memory> = {}): Memory {
  return {
    id: `mem_${Math.random().toString(36).slice(2)}`,
    scope: "global",
    type: "semantic",
    text: "Prefers pnpm over npm for all JavaScript projects.",
    tags: ["tooling"],
    importance: 7,
    createdAt: MEMORY_NOW - 3 * 24 * 60 * 60_000,
    updatedAt: MEMORY_NOW - 60 * 60_000,
    lastAccessedAt: MEMORY_NOW - 30 * 60_000,
    accessCount: 4,
    version: 2,
    status: "active",
    pinned: false,
    provenance: "user",
    ...over,
  }
}

/** A spread of memories across types / statuses for the console. */
export function makeMemorySet(): Memory[] {
  const seed: { type: MemoryType; text: string; importance: number }[] = [
    { type: "semantic", text: "Prefers pnpm over npm for all projects.", importance: 8 },
    { type: "semantic", text: "Lives in the GMT+8 timezone.", importance: 5 },
    {
      type: "episodic",
      text: "Decided to adopt Tauri for the desktop shell on 2026-05-02.",
      importance: 6,
    },
    { type: "procedural", text: "Always write a failing test before fixing a bug.", importance: 9 },
    { type: "episodic", text: "Shipped the goal-console redesign last sprint.", importance: 4 },
  ]
  return seed.map((s, i) =>
    makeMemory({
      id: `mem_${i + 1}`,
      type: s.type,
      text: s.text,
      importance: s.importance,
      pinned: i === 3,
      sourceSessionId: i % 2 === 0 ? `ses_${i + 1}` : undefined,
      lastAccessedAt: MEMORY_NOW - i * 45 * 60_000,
    })
  )
}
