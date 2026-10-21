/**
 * The plugin contract's share of `lib/plugin/api/view-container-errors.ts`, which re-exports these.
 */
/**
 * Refusals from `ctx.ui.openViewContainer(containerId)`.
 *
 * Kept dependency-free (no registry, store or guard) so the plugin SDK root can
 * re-export the type guard without dragging host state into an author bundle.
 * The opener itself lives in `./view-container-api.ts`.
 */

/**
 * - `invalid-id`: the id was not a non-empty string.
 * - `not-registered`: no container with that id is registered (never declared,
 *   or its plugin is disabled).
 * - `foreign`: the id names another plugin's container; a plugin may only open
 *   its own.
 */
export type ViewContainerOpenErrorCode = "invalid-id" | "not-registered" | "foreign"
