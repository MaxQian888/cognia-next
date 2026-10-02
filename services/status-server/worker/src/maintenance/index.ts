/**
 * Maintenance module (owner E): snapshot windows, availability exclusions,
 * active-maintenance lookup and time-driven transitions. Exports exactly the
 * `MaintenanceModule` surface of `src/seams.ts`; operator writes live in
 * `./admin.ts` and are routed by `src/admin`.
 */

import type { MaintenanceModule } from "../seams"
import { advanceMaintenance as advance } from "./lifecycle"
import { loadActiveComponents, loadComponentExclusions, loadSnapshotMaintenance } from "./store"

export const loadMaintenanceForSnapshot: MaintenanceModule["loadMaintenanceForSnapshot"] = (
  env,
  nowMs
) => loadSnapshotMaintenance(env.DB, nowMs)

export const loadExclusionWindows: MaintenanceModule["loadExclusionWindows"] = (
  env,
  fromMs,
  toMs
) => loadComponentExclusions(env.DB, fromMs, toMs)

export const activeMaintenanceComponents: MaintenanceModule["activeMaintenanceComponents"] = (
  env,
  nowMs
) => loadActiveComponents(env.DB, nowMs)

export const advanceMaintenance: MaintenanceModule["advanceMaintenance"] = advance
