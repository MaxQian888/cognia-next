/**
 * Static teaser cards rendered in the Skills marketplace tab when the user
 * has not yet configured a SkillsMP endpoint. Click-through opens settings;
 * the cards are display-only.
 */

export interface MarketplaceTeaser {
  id: string
  name: string
  description: string
  author: string
  category: string
}

export const MARKETPLACE_TEASERS: MarketplaceTeaser[] = [
  {
    id: "teaser-code-reviewer",
    name: "Code Reviewer",
    description: "Senior-engineer-style review focused on safety and clarity.",
    author: "Cognia",
    category: "development",
  },
  {
    id: "teaser-meeting-notetaker",
    name: "Meeting Notetaker",
    description: "Turns rough notes into structured minutes with action items.",
    author: "Cognia",
    category: "productivity",
  },
  {
    id: "teaser-sql-explainer",
    name: "SQL Explainer",
    description: "Breaks down EXPLAIN output and recommends an index.",
    author: "Cognia",
    category: "data-analysis",
  },
  {
    id: "teaser-email-rewriter",
    name: "Email Rewriter",
    description: "Rewrites an email draft for a specified tone.",
    author: "Cognia",
    category: "communication",
  },
]
