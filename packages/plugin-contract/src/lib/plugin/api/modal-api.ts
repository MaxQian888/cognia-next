/**
 * The plugin contract's share of `lib/plugin/api/modal-api.ts`, which re-exports these.
 */
import type {
  PluginModalComponent,
  PluginModalHandle,
  PluginModalOptions,
} from "../../../types/plugin/plugin-modal"

export interface PluginModalAPI {
  /**
   * Push a new modal onto the stack. Returns a handle whose `close()`
   * dismisses it. Plugin authors should usually close from inside the
   * modal component (via the `onClose` prop) rather than holding the
   * handle externally.
   *
   * `options` is additive and optional on purpose — every existing
   * two-argument call keeps producing the centered, medium dialog it produced
   * before this parameter existed.
   */
  openModal(
    component: PluginModalComponent,
    args?: Record<string, unknown>,
    options?: PluginModalOptions
  ): PluginModalHandle
  /**
   * Open a modal declared in `manifest.modalMounts[]` by its (unprefixed)
   * id. The component is resolved lazily on first open. Resolves to a handle,
   * or `null` if the id is unknown or its component failed to load.
   *
   * `options` layers on top of the entry's declared
   * `manifest.modalMounts[].options`, field by field.
   */
  openById(
    modalId: string,
    args?: Record<string, unknown>,
    options?: PluginModalOptions
  ): Promise<PluginModalHandle | null>
  /** Close every modal this plugin opened. */
  closeAll(): void
}
