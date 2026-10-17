import { approvalAwareTransport } from "@/lib/task-workspace/user-action"
import type {
  BestOfNGroup,
  BestOfNMutation,
  BestOfNProgress,
  StartBestOfN,
} from "@/types/best-of-n"

export interface BestOfNHost {
  start(input: StartBestOfN): Promise<BestOfNGroup>
  get(groupId: string): Promise<BestOfNGroup>
  list(): Promise<BestOfNGroup[]>
  cancel(input: BestOfNMutation): Promise<BestOfNGroup>
  select(input: {
    mutation: BestOfNMutation
    candidateId: string
    headSha: string
  }): Promise<BestOfNGroup>
  archive(input: BestOfNMutation): Promise<BestOfNGroup>
  recover(input: BestOfNMutation): Promise<BestOfNGroup>
  progress(input: BestOfNProgress): Promise<BestOfNGroup>
}

/** Selection authorization lives in the Host; no request field can assert a human origin. */
export function createBestOfNHost(
  call: <T>(command: string, args: Record<string, unknown>) => Promise<T> = (command, args) =>
    approvalAwareTransport.call(command, args)
): BestOfNHost {
  return {
    start: (input) => call("best_of_n_start", { input }),
    get: async (groupId) => {
      const group = await call<BestOfNGroup | null>("best_of_n_get", { groupId })
      if (!group) throw new Error(`Best-of-N group not found: ${groupId}`)
      return group
    },
    list: () => call("best_of_n_list", {}),
    cancel: (input) => call("best_of_n_cancel", { input }),
    select: (input) => call("best_of_n_select", { input }),
    archive: (input) => call("best_of_n_archive", { input }),
    recover: (input) => call("best_of_n_recover", { input }),
    progress: (input) => call("best_of_n_candidate_progress", { input }),
  }
}
