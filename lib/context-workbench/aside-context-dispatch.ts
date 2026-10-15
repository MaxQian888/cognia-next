import type { ChatSession } from "@cognia/agent-config-types"
import type { AsideContextDelivery } from "@/lib/chat/session-aside-context"

/** Join transport acceptance with the SDK identity event, in either order. */
export function createAsideContextDispatch(
  cursor: NonNullable<AsideContextDelivery["cursor"]>,
  persist: (cursor: NonNullable<ChatSession["asideContextCursor"]>) => Promise<void>,
  resumeSdkSessionId?: string,
  turnId?: string
) {
  let accepted = false
  let cancelled = false
  let sdkSessionId = resumeSdkSessionId
  let savedSdkSessionId: string | undefined
  const flush = async () => {
    if (!accepted || cancelled || !sdkSessionId || savedSdkSessionId === sdkSessionId) return
    const sentUnder = sdkSessionId
    await persist({ ...cursor, sdkSessionId: sentUnder })
    savedSdkSessionId = sentUnder
  }
  return {
    async acknowledgeSdk(id: string, eventTurnId?: string) {
      if (eventTurnId && turnId && eventTurnId !== turnId) return
      sdkSessionId = id
      await flush()
    },
    async dispatched() {
      accepted = true
      await flush()
    },
    cancel() {
      cancelled = true
    },
  }
}
