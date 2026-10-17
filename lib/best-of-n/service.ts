import { createBestOfNService, type BestOfNInput } from "./core"
import { createBestOfNHost } from "./host"
import { createBestOfNExecution } from "./runtime"

let service: ReturnType<typeof createBestOfNService> | undefined
export function bestOfNService() {
  return (service ??= createBestOfNService({
    host: createBestOfNHost(),
    execution: createBestOfNExecution(),
    ownerId: crypto.randomUUID(),
  }))
}
/** Both future composer surfaces call this once, consuming their ordinary send. */
export function startBestOfN(input: BestOfNInput) {
  return bestOfNService().startBestOfN(input)
}
export function recoverBestOfN(groupId: string) {
  return bestOfNService().recover(groupId)
}
export function cancelBestOfN(groupId: string) {
  return bestOfNService().cancel(groupId)
}
