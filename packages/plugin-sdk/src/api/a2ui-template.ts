/**
 * Plugin SDK - `a2ui-template` capability surface.
 *
 * Re-exports the declarative authoring helper and A2UI template/component-tree
 * contracts. Runtime materialization remains owned by the host A2UI bridge.
 */

export { defineA2UITemplate } from "../define/define-a2ui-template"

export type { A2UITemplateDef } from "@/types/plugin"
export type { A2UIComponent, A2UISurfaceType } from "@/types/artifact/a2ui"
