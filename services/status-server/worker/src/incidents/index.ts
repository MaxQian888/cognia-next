/**
 * Incidents module (owner E): public incident reads, the snapshot's
 * incident lists and automated reconciliation. Exports exactly the
 * `IncidentsModule` surface of `src/seams.ts`; operator writes live in
 * `./admin.ts` and are routed by `src/admin`.
 */

import type { IncidentsModule } from "../seams"
import { reconcileIncidents as reconcile } from "./reconcile"
import { handleIncidentRoutes as routes } from "./routes"
import { loadSnapshotIncidents } from "./store"

export const handleIncidentRoutes: IncidentsModule["handleIncidentRoutes"] = routes

export const loadIncidentsForSnapshot: IncidentsModule["loadIncidentsForSnapshot"] = (env, nowMs) =>
  loadSnapshotIncidents(env.DB, nowMs)

export const reconcileIncidents: IncidentsModule["reconcileIncidents"] = reconcile
