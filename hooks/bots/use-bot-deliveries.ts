"use client"

/**
 * The recent deliveries for one installation.
 *
 * A live query rather than a fetch, because a delivery moves through the queue
 * on its own: pending, leased, running, parked, then settled. A snapshot taken
 * once shows the state at the moment the pane opened and then quietly lies.
 *
 * Capped, and the cap is part of the contract. A busy Bot accumulates
 * thousands of rows over the retention window, and a pane that rendered all of
 * them would spend its scroll on last fortnight's successes. What a person
 * comes here for is the failures and the last few of everything else.
 */

import { useLiveQuery } from "dexie-react-hooks"

import { listBotDeliveries } from "@/lib/db/bot-event-deliveries"
import type { BotEventDeliveryRow } from "@/lib/db/bot-types"

/** How many rows the pane shows. Newest first, which is what `listBotDeliveries` returns. */
export const BOT_DELIVERY_PAGE_SIZE = 40

export interface UseBotDeliveriesResult {
  rows: BotEventDeliveryRow[]
  /** True until the first read resolves. Distinct from "no deliveries yet". */
  loading: boolean
}

export function useBotDeliveries(installationId: string | null): UseBotDeliveriesResult {
  const rows = useLiveQuery(
    async () =>
      installationId
        ? listBotDeliveries({ installationId, limit: BOT_DELIVERY_PAGE_SIZE })
        : ([] as BotEventDeliveryRow[]),
    [installationId]
  )
  return { rows: rows ?? [], loading: rows === undefined }
}
