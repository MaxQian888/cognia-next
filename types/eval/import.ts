/**
 * Re-export shim. The eval domain model now lives in `@cognia/eval-core` so
 * the CLI, CI, and the app all compile against one definition — see
 * `packages/eval-core/src/domain/import.ts`.
 *
 * This path is kept because ~83 modules import it; new code should import from
 * `@cognia/eval-core` directly.
 */
export * from "@cognia/eval-core/domain/import"
