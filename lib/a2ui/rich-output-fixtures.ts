export interface RichOutputFixture {
  profileId: string
  title: string
  description?: string
  content?: string
}

export const richOutputFixtures = {
  directResponse: {
    profileId: "quick-factual-answer",
    title: "Battery Voltage Answer",
    description: "A concise direct response fixture.",
    content: "A healthy AA battery usually measures around 1.5V.",
  },
  svgDiagram: {
    profileId: "how-it-works-physical",
    title: "Cooling System Diagram",
    description: "Representative SVG explanatory fixture.",
    content:
      '<svg viewBox="0 0 120 80" xmlns="http://www.w3.org/2000/svg"><rect x="8" y="26" width="34" height="28" rx="6" fill="#0ea5e9"/><rect x="78" y="26" width="34" height="28" rx="6" fill="#38bdf8"/><path d="M42 40h36" stroke="#0f172a" stroke-width="4" stroke-linecap="round"/><text x="25" y="66" font-size="8" text-anchor="middle">Pump</text><text x="95" y="66" font-size="8" text-anchor="middle">Radiator</text></svg>',
  },
  mermaidSchema: {
    profileId: "database-schema-erd",
    title: "Project Relationship Diagram",
    description: "Representative Mermaid relationship fixture.",
    content:
      "erDiagram\n  PROJECT ||--o{ SESSION : contains\n  SESSION ||--o{ MESSAGE : contains\n  MESSAGE ||--o{ ARTIFACT : creates",
  },
  htmlDashboard: {
    profileId: "kpis-metrics",
    title: "Product Metrics Dashboard",
    description: "Representative HTML dashboard fixture.",
    content:
      '<!doctype html><html><body style="font-family:system-ui;padding:16px;background:#f8fafc"><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px"><section style="background:white;padding:16px;border-radius:12px"><div style="font-size:12px;color:#64748b">MRR</div><div style="font-size:28px;font-weight:700">$128K</div></section><section style="background:white;padding:16px;border-radius:12px"><div style="font-size:12px;color:#64748b">Activation</div><div style="font-size:28px;font-weight:700">63%</div></section><section style="background:white;padding:16px;border-radius:12px"><div style="font-size:12px;color:#64748b">Churn</div><div style="font-size:28px;font-weight:700">2.1%</div></section></div></body></html>',
  },
} satisfies Record<string, RichOutputFixture>

export type RichOutputFixtureKey = keyof typeof richOutputFixtures

export function getRichOutputFixture(key: RichOutputFixtureKey): RichOutputFixture | undefined {
  return richOutputFixtures[key]
}
