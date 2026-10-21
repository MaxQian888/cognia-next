/**
 * The plugin contract's share of `lib/automation/action-schemas.ts`, which re-exports these.
 */
import type {
  actionRequestSchema,
  appLocatorSchema,
  dragOptsSchema,
  elementHandleSchema,
  getAppStateOptionsSchema,
  locatorSchema,
  mouseButtonSchema,
  pointSchema,
  scrollOptsSchema,
  uiTreeProjectionKindSchema,
} from "@/lib/automation/action-schemas"
import type { z } from "zod"

export type Point = z.infer<typeof pointSchema>

export type MouseButton = z.infer<typeof mouseButtonSchema>

export type DragOpts = z.infer<typeof dragOptsSchema>

export type ScrollOpts = z.infer<typeof scrollOptsSchema>

export type UiTreeProjectionKind = z.infer<typeof uiTreeProjectionKindSchema>

export type ElementHandle = z.infer<typeof elementHandleSchema>

export type ActionRequest = z.infer<typeof actionRequestSchema>

export type Locator = z.infer<typeof locatorSchema>

export type GetAppStateOptions = z.infer<typeof getAppStateOptionsSchema>

export type AppLocator = z.infer<typeof appLocatorSchema>
