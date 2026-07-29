// Curated marketplace repositories offered in the add-source empty state.
//
// Ships EMPTY on purpose. The empty state's job is to stop being a dead end,
// and a one-click button pointing at a repository that 404s is a worse dead
// end than no button at all — so the list stays empty until repositories that
// actually exist are published, and `PluginRecommendedSources` renders nothing
// (the dialog falls back to its plain empty sentence) while it is.
//
// When populating: `name` and `description` are user-facing and are NOT
// covered by `lint:i18n` (that gate reads .tsx, not .ts constants). Either
// translate them at the point of use or keep them to untranslatable proper
// nouns before adding an entry here.

/** A curated marketplace offered as a one-click first source. */
export interface RecommendedMarketplaceSource {
  /** `owner/repo[@ref]` — parsed with the same rules as the free-form input. */
  repoRef: string
  name: string
  description: string
}

export const RECOMMENDED_MARKETPLACE_SOURCES: readonly RecommendedMarketplaceSource[] = []
