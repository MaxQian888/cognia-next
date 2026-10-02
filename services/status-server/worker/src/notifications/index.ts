/**
 * Notifications module (owner E): outbox delivery, notification retention
 * and operator alerts. Exports exactly the `NotificationsModule` surface of
 * `src/seams.ts`; delivery inspection / retry for operators lives in
 * `./admin.ts` and is routed by `src/admin`.
 */

import type { NotificationsModule } from "../seams"
import { alertOperator as alert } from "./alerts"
import { runDelivery as delivery } from "./delivery"
import { runNotificationRetention as retention } from "./retention"

export const runDelivery: NotificationsModule["runDelivery"] = delivery
export const runNotificationRetention: NotificationsModule["runNotificationRetention"] = retention
export const alertOperator: NotificationsModule["alertOperator"] = alert
