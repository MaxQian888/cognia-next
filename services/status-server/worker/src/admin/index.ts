/**
 * Admin module (owner E): the Access-protected operator API. Exports
 * exactly the `AdminModule` surface of `src/seams.ts`.
 */

import type { AdminModule } from "../seams"
import { handleAdminRoutes as routes } from "./router"

export const handleAdminRoutes: AdminModule["handleAdminRoutes"] = routes
