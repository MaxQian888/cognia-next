/**
 * Side-effect CSS imports.
 *
 * The bundler turns `import "./tokens.css"` into a stylesheet link; TypeScript
 * needs to be told the module exists at all. WXT's generated types do not cover
 * it because the import is ours, not an entrypoint's.
 */
declare module "*.css"
