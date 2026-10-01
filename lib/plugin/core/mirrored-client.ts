/**
 * Whether this runtime's plugin tables mirror a host's rather than being the
 * authority. A leaf module so anything on the install path can ask without
 * importing the enable/disable path (and through it the plugin manager).
 */

import { isCapacitor } from "@/lib/platform/detect"
import { hasWebCompanionTarget } from "@/lib/platform/web-companion"

/**
 * True when this runtime's `plugins` rows mirror some host's rather than being
 * the authority. Exported so surfaces can label the affordance honestly, since
 * a queued toggle is not the same promise as an applied one.
 */
export function isMirroredPluginClient(): boolean {
  return isCapacitor() || hasWebCompanionTarget()
}
