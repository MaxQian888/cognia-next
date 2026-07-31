/**
 * Plugin SDK - `a2ui-component` capability surface.
 *
 * Re-exports the declarative authoring helper and A2UI component contribution
 * contracts. The live bridge depends on renderer stores, so this SDK subpath
 * stays as a lightweight authoring/type facade.
 */

export { defineA2UIComponent } from "../define/define-a2ui-component"

export type {
  A2UIPluginComponentDef,
  A2UIPluginComponentProps,
  PluginA2UIComponent,
} from "@/types/plugin"
