/**
 * Lark presence — 系统状态 (system status) badge + message pin.
 *
 * Feishu has no writable "personal signature" API; the only OpenAPI surface
 * that puts a live text badge next to a user's name is the System Status
 * family (`personal_settings/v1/system_statuses`, tenant token, scopes
 * `personal_settings:status:system_status_update` + `…_operate`):
 *
 *   - create   POST  /personal_settings/v1/system_statuses   (≤10 per tenant)
 *   - patch    PATCH /personal_settings/v1/system_statuses/:id
 *   - open     POST  …/:id/batch_open   (≤50 users per call)
 *   - close    POST  …/:id/batch_close
 *
 * Critical platform caveat: a PATCHed title does NOT propagate to users who
 * currently have the status open — Lark only syncs the new title the next
 * time the status is (re)opened for the user. A live-updating badge must
 * therefore run the full patch(title) → batch_close → batch_open cycle on
 * every refresh. Title budget: 20 weighted chars (1 CJK = 2); the runner
 * pre-truncates via `formatShortStatus`, we hard-truncate again as defense.
 */

import type { PresenceStatusInput } from "@/types/connectors/presence"
import { truncateWeighted } from "@/lib/usage/status-snapshot"

/** Chunk `batch_open`/`batch_close` user lists to Lark's 50-user cap. */
const BATCH_USER_CAP = 50

/** Lark title budget in weighted units (1 CJK = 2). */
const TITLE_BUDGET = 20

export interface LarkPresenceDeps {
  adapterId: string
  /** Authenticated tenant-token request against `open.feishu.cn/open-apis`. */
  request: (
    method: "GET" | "POST" | "PATCH" | "DELETE",
    urlPath: string,
    body?: unknown
  ) => Promise<unknown>
  /** Read the persisted Lark system-status id (lazily created). */
  getStatusId: () => Promise<string | undefined>
  /** Persist a freshly created system-status id. */
  setStatusId: (id: string) => Promise<void>
}

interface LarkStatusEnvelope {
  data?: { system_status?: { system_status_id?: string; id?: string } }
}

function chunk<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

export function createLarkPresence(deps: LarkPresenceDeps): {
  setPresenceStatus: (input: PresenceStatusInput) => Promise<void>
  pinMessage: (conversationKey: string, messageId: string) => Promise<void>
} {
  async function ensureStatusId(title: string): Promise<string> {
    const existing = await deps.getStatusId()
    if (existing) return existing
    const created = (await deps.request("POST", "/personal_settings/v1/system_statuses", {
      title,
      i18n_title: { zh_cn: title, en_us: title },
      color: "BLUE",
    })) as LarkStatusEnvelope | null
    const id = created?.data?.system_status?.system_status_id ?? created?.data?.system_status?.id
    if (!id) {
      throw new Error("Lark system_statuses create returned no id")
    }
    await deps.setStatusId(id)
    return id
  }

  async function setPresenceStatus(input: PresenceStatusInput): Promise<void> {
    const title = truncateWeighted(input.text, TITLE_BUDGET)
    if (!title) return
    const existing = await deps.getStatusId()
    const statusId = await ensureStatusId(title)

    // Freshly created statuses already carry the title; only patch a reused one.
    if (existing) {
      await deps.request("PATCH", `/personal_settings/v1/system_statuses/${statusId}`, {
        system_status: { title, i18n_title: { zh_cn: title, en_us: title } },
        update_fields: ["TITLE", "I18N_TITLE"],
      })
    }

    const users = (input.targetUserIds ?? []).filter(Boolean)
    if (users.length === 0) return

    // Lark does not push a patched title to already-open statuses — cycle
    // close → open so every target user sees the fresh text.
    const endTime = String(
      Math.floor((input.expiresAt ?? Date.now() + 30 * 60_000) / 1000) // default 30 min
    )
    for (const group of chunk(users, BATCH_USER_CAP)) {
      // Best-effort close: statuses that were never open return per-user
      // failure codes inside a code=0 envelope — no throw, safe to ignore.
      await deps.request(
        "POST",
        `/personal_settings/v1/system_statuses/${statusId}/batch_close?user_id_type=open_id`,
        { user_list: group }
      )
      await deps.request(
        "POST",
        `/personal_settings/v1/system_statuses/${statusId}/batch_open?user_id_type=open_id`,
        { user_list: group.map((userId) => ({ user_id: userId, end_time: endTime })) }
      )
    }
  }

  async function pinMessage(_conversationKey: string, messageId: string): Promise<void> {
    await deps.request("POST", "/im/v1/pins", { message_id: messageId })
  }

  return { setPresenceStatus, pinMessage }
}
