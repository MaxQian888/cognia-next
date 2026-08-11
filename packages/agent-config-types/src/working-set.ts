import type { ResourceRefV1 } from "./governance"

export const SESSION_WORKING_SET_CONTRACT_VERSION = 1 as const

export type WorkingSetEntryKind = "fact" | "decision" | "open-question" | "resource" | "subtask"

export type WorkingSetEntryStatus = "active" | "resolved"
export type WorkingSetEntryOrigin = "user" | "agent"

export interface WorkingSetEntry {
  id: string
  kind: WorkingSetEntryKind
  summary: string
  status: WorkingSetEntryStatus
  origin: WorkingSetEntryOrigin
  refs: ResourceRefV1[]
  createdAt: number
  updatedAt: number
}

export interface SessionWorkingSetV1 {
  contractVersion: typeof SESSION_WORKING_SET_CONTRACT_VERSION
  revision: number
  entries: WorkingSetEntry[]
  updatedAt: number
}
