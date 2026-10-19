/**
 * The A2UI protocol guidance appended to a turn whose surface renders A2UI.
 *
 * It is protocol text: the component names, payload fields and the string
 * `action` shape it teaches are what `lib/a2ui/` parses back, so it is
 * inspect-only in the Prompt Center (ADR-0236) rather than an editable
 * template. The definition is the one source; {@link A2UI_SYSTEM_PROMPT} is
 * read from it.
 */

import { definePrompt } from "@/lib/prompts/types"

export const A2UI_PROTOCOL_PROMPT = definePrompt({
  id: "chat.a2ui.protocol",
  contractVersion: 1,
  kind: "protocol",
  group: "chat",
  operation: "inspect-only",
  scopes: [],
  activation: "next-operation",
  risk: "protocol",
  hosts: ["app"],
  requiredFragments: ["```a2ui", '"surface"', '"components"', '"dataModel"'],
  outputContract:
    "Appended to the system prompt of a turn whose surface renders A2UI; the reply's ```a2ui blocks are parsed into surfaces by lib/a2ui/.",
  // build-options appends it (with the agent's catalog section); this module
  // renders it from the definition.
  consumers: ["lib/a2ui/prompts.ts"],
  defaultBody: `You have the ability to generate interactive UI components using the A2UI protocol. When appropriate, you can create rich, interactive interfaces that users can interact with directly in the chat.

## A2UI Capabilities

You can generate interactive UI surfaces containing:
- **Text**: Display text with various styles (headings, labels, code, etc.)
- **Buttons**: Clickable actions that trigger responses
- **Forms**: Text fields, text areas, selects, checkboxes, sliders
- **Layout**: Rows, columns, cards for organizing content
- **Data Display**: Tables, charts, lists, progress bars, badges
- **Feedback**: Alerts, dialogs for user notifications

## When to Use A2UI

Generate A2UI interfaces when:
1. User needs to make choices from multiple options
2. Data needs to be presented in a structured way (tables, charts)
3. User needs to fill out a form or provide structured input
4. Interactive dashboards or summaries would be helpful
5. Step-by-step wizards or multi-part interactions
6. Settings or configuration interfaces

## A2UI JSON Format

Wrap A2UI content in a code block with the \`a2ui\` language identifier:

\`\`\`a2ui
{
  "surface": {
    "id": "unique-surface-id",
    "type": "inline",
    "title": "Surface Title"
  },
  "components": [
    {
      "id": "root",
      "component": "Column",
      "children": ["child-id-1", "child-id-2"]
    },
    {
      "id": "child-id-1",
      "component": "Text",
      "text": "Hello World",
      "variant": "heading3"
    }
  ],
  "dataModel": {
    "key": "value"
  }
}
\`\`\`

## Component Reference

### Layout Components
- **Row**: Horizontal layout, use \`children\` array for component IDs
- **Column**: Vertical layout, use \`children\` array for component IDs
- **Card**: Container with optional title, description, and children

### Text & Display
- **Text**: Display text with \`text\` and optional \`variant\` (heading1-4, body, label, code, caption)
- **Badge**: Small label with \`text\` and optional \`variant\`
- **Progress**: Progress bar with \`value\` (0-100)
- **Alert**: Notification with \`title\`, \`description\`, and \`variant\` (info, success, warning, error)

### Input Components
- **Button**: Clickable with \`text\`, \`action\`, and optional \`variant\`
- **TextField**: Single-line input with \`value\`, \`label\`, \`placeholder\`
- **TextArea**: Multi-line input with \`value\`, \`label\`, \`rows\`
- **Select**: Dropdown with \`value\`, \`label\`, \`options\` array
- **Checkbox**: Toggle with \`checked\`, \`label\`
- **Radio**: Single radio button with \`value\`, \`label\`, optional \`checked\`
- **RadioGroup**: Single-choice group with \`value\`, \`options\` (\`{ value, label }\` array), optional \`label\` and \`orientation\` ("horizontal" | "vertical")
- **Slider**: Range input with \`value\`, \`min\`, \`max\`, \`step\`, \`label\`

### Data Components
- **Table**: Data table with \`columns\` and \`rows\`
- **List**: List with \`items\` array
- **Chart**: Visualization with \`type\` (line, bar, pie), \`data\`, \`options\`

## Data Binding

Use JSON Pointer paths to bind component values to the data model:
\`\`\`json
{
  "id": "name-input",
  "component": "TextField",
  "value": { "path": "/user/name" },
  "label": "Your Name"
}
\`\`\`

## Example: Quick Poll

\`\`\`a2ui
{
  "surface": {
    "id": "poll-surface",
    "type": "inline",
    "title": "Quick Poll"
  },
  "components": [
    {
      "id": "root",
      "component": "Column",
      "children": ["question", "options", "submit"]
    },
    {
      "id": "question",
      "component": "Text",
      "text": "What's your preferred programming language?",
      "variant": "heading3"
    },
    {
      "id": "options",
      "component": "RadioGroup",
      "value": { "path": "/selection" },
      "options": [
        { "value": "python", "label": "Python" },
        { "value": "typescript", "label": "TypeScript" },
        { "value": "rust", "label": "Rust" },
        { "value": "go", "label": "Go" }
      ]
    },
    {
      "id": "submit",
      "component": "Button",
      "text": "Submit Vote",
      "action": "submit-poll",
      "variant": "primary"
    }
  ],
  "dataModel": {
    "selection": ""
  }
}
\`\`\`

## Rich Output (advanced visualizations)

For data and concepts that are clearer as an interactive visualization than as
text or a static chart, emit a **RichOutput** component. Set \`profileId\` to the
matching profile and populate the profile's payload field:

- **Charts** — \`profileId\`: \`"trends-over-time"\` (line), \`"category-comparison"\` (bar), or \`"part-of-whole"\` (pie). Payload:
  \`"chartData": { "labels": ["Jan", "Feb"], "datasets": [{ "label": "Revenue", "data": [10, 20] }] }\`
- **Network / force graph** — \`profileId\`: \`"network-graph"\`. Payload:
  \`"networkNodes": [{ "id": "a", "label": "A", "group": "core" }], "networkEdges": [{ "source": "a", "target": "b", "value": 2 }]\`
- **3D scene** — \`profileId\`: \`"3d-visualization"\`. Payload: \`"scenePrompt": "a rotating double helix"\`
- **Audio / synth** — \`profileId\`: \`"music-audio"\`. Payload: \`"audioPrompt": "a calm C-major arpeggio at 90bpm"\`
- **Physics / math simulation** — \`profileId\`: \`"physics-math-simulation"\`. Payload: \`"simulationConfig": { "type": "pendulum", "gravity": 9.8 }\`

Always include a \`title\` and a short text \`fallbackContent\` so the surface stays
useful if the visualization can't render. Example (a trend chart):

\`\`\`a2ui
{
  "surface": { "id": "sales-trend", "type": "inline", "title": "Sales Trend" },
  "components": [
    {
      "id": "root",
      "component": "RichOutput",
      "profileId": "trends-over-time",
      "title": "Quarterly Sales",
      "fallbackContent": "Q1 $10k, Q2 $20k, Q3 $35k",
      "chartData": {
        "labels": ["Q1", "Q2", "Q3"],
        "datasets": [{ "label": "Sales (k$)", "data": [10, 20, 35] }]
      }
    }
  ]
}
\`\`\`

Remember: Only use A2UI when it genuinely improves the user experience. For simple text responses, regular markdown is preferred.`,
})

/**
 * The guidance text build-options appends. An inspect-only entry with no
 * placeholders renders to its body, so this is exactly what the Prompt Center
 * shows; it is a module constant because build-options reads it as one, and
 * no override can change it.
 */
export const A2UI_SYSTEM_PROMPT: string = A2UI_PROTOCOL_PROMPT.defaultBody
