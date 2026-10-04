import { PluginSurfaceReferenceHarness } from "./plugin-surface-reference-harness"
import { PluginModalRoot } from "@/components/plugins/dialogs/plugin-modal-root"
import { PluginRuntimeInitializer } from "@/components/providers/initializers/plugin-runtime-initializer"

export default function PluginUiSurfacesE2EPage() {
  return (
    <>
      <PluginRuntimeInitializer onlyForPluginSurfaceE2E />
      <PluginSurfaceReferenceHarness force />
      <PluginModalRoot />
    </>
  )
}
