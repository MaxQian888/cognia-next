/**
 * The plugin contract's share of `lib/plugin/character-pack/validate-requires.ts`, which re-exports these.
 */
export interface PluginCharacterPackWarning {
  /** Stable id used to dedupe warnings on the UI. */
  code:
    | "missing-skill"
    | "missing-plugin-skill"
    | "missing-mcp-preset"
    | "missing-native-tool"
    | "missing-a2ui-catalog"
    | "missing-theme-pack"
    | "missing-connector"
    | "missing-provider"
  /** The id we couldn't resolve. */
  missingId: string
  /** Which pack character (if any) references the missing id. */
  characterLocalId?: string
}
