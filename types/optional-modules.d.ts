/**
 * Ambient declarations for optional runtime dependencies that are not listed in
 * package.json. The app dynamically imports these at runtime and falls back to
 * a no-op when the module is absent. Declaring them here lets TypeScript accept
 * the dynamic import without the package being installed.
 */

declare module "langfuse"
