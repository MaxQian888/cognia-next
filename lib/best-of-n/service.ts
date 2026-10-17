import { createBestOfNService, type BestOfNInput } from "./core"
import { createBestOfNHost } from "./host"
import { createBestOfNExecution } from "./runtime"
import { projectBestOfNGroup, refreshBestOfNRun } from "./projection"
import type { BestOfNGroup } from "@/types/best-of-n"

async function project(group: BestOfNGroup) {
  try {
    await projectBestOfNGroup(group)
  } catch (error) {
    // The Host already committed. Retrying its mutation because a disposable
    // projection failed could duplicate execution; refresh rebuilds the view.
    console.warn("Best-of-N summary projection failed", error)
  }
  return group
}

function projectedHost() {
  const host = createBestOfNHost()
  return {
    ...host,
    start: (...args: Parameters<typeof host.start>) => host.start(...args).then(project),
    get: (...args: Parameters<typeof host.get>) => host.get(...args).then(project),
    cancel: (...args: Parameters<typeof host.cancel>) => host.cancel(...args).then(project),
    select: (...args: Parameters<typeof host.select>) => host.select(...args).then(project),
    archive: (...args: Parameters<typeof host.archive>) => host.archive(...args).then(project),
    recover: (...args: Parameters<typeof host.recover>) => host.recover(...args).then(project),
    progress: async (...args: Parameters<typeof host.progress>) => {
      const group = await project(await host.progress(...args))
      if (["succeeded", "failed", "cancelled", "recoveryRequired"].includes(args[0].status)) {
        try {
          await refreshBestOfNRun(group.groupId)
        } catch (error) {
          console.warn("Best-of-N evidence projection failed", error)
        }
      }
      return group
    },
  }
}

let service: ReturnType<typeof createBestOfNService> | undefined
export function bestOfNService() {
  return (service ??= createBestOfNService({
    host: projectedHost(),
    execution: createBestOfNExecution(),
    ownerId: crypto.randomUUID(),
  }))
}
/** Both composer surfaces call this once, consuming their ordinary send. */
export function startBestOfN(input: BestOfNInput) {
  return bestOfNService().startBestOfN(input)
}
export function recoverBestOfN(groupId: string) {
  return bestOfNService().recover(groupId)
}
export function cancelBestOfN(groupId: string) {
  return bestOfNService().cancel(groupId)
}
