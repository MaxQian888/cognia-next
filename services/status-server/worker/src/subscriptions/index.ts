/**
 * Subscriptions module (owner E): anonymous double-opt-in signup, token
 * confirmation / management / unsubscribe, the email capability gate and
 * retention. Exports exactly the `SubscriptionsModule` surface of
 * `src/seams.ts`.
 */

import type { SubscriptionsModule } from "../seams"
import { emailCapability as capability } from "./capability"
import { runSubscriptionRetention as retention } from "./retention"
import { handleSubscriptionRoutes as routes } from "./routes"

export const handleSubscriptionRoutes: SubscriptionsModule["handleSubscriptionRoutes"] = routes
export const emailCapability: SubscriptionsModule["emailCapability"] = capability
export const runSubscriptionRetention: SubscriptionsModule["runSubscriptionRetention"] = retention
