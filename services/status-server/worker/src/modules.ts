/**
 * Composition shared by the Worker entrypoint and its tests. Kept out of
 * `index.ts` because a Worker's main module may export only handlers.
 */

import type { CronModules } from "./cron"
import * as incidents from "./incidents"
import * as maintenance from "./maintenance"
import * as notifications from "./notifications"
import * as subscriptions from "./subscriptions"

export const API_PREFIX = "/api/status/v1"

/** The owner-E modules the one-minute schedule drives. */
export const cronModules: CronModules = { incidents, maintenance, notifications, subscriptions }
