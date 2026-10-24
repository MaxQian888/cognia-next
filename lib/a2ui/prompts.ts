/**
 * The A2UI protocol guidance appended to a turn whose surface renders A2UI.
 *
 * It is protocol text: the component names, payload fields and the string
 * `action` shape it teaches are what `lib/a2ui/` parses back, so it is
 * inspect-only in the Prompt Center (ADR-0236) rather than an editable
 * template. The definition is the one source; {@link A2UI_SYSTEM_PROMPT} is
 * read from it.
 */

import { createA2UIComponentBundle } from "./component-definitions"
import { getStandardComponentTypes } from "./catalog"
import { A2UI_LOCAL_ACTION_NAMES } from "./chat-action-routing"
import { A2UI_COMPUTED_LIMITS, A2UI_COMPUTED_OPS } from "./computed"
import { getA2UIEnumPropertyDefinitions } from "./component-properties"
import { definePrompt } from "@/lib/prompts/types"

export const A2UI_PROTOCOL_PROMPT = definePrompt({
  id: "chat.a2ui.protocol",
  // 2: action round trip and declared `computed` values (ADR-0240).
  contractVersion: 2,
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
  defaultBody:
    `You have the ability to generate interactive UI components using the A2UI protocol. When appropriate, you can create rich, interactive interfaces that users can interact with directly in the chat.

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
2. Structured data sits next to controls (filters, selection, inputs)
3. User needs to fill out a form or provide structured input
4. Interactive dashboards or summaries would be helpful
5. Step-by-step wizards or multi-part interactions
6. Settings or configuration interfaces
7. A calculator-like tool whose result follows its inputs (see Computed Values)

A chart or table the reader only looks at follows this conversation's visual-output guidance (a dock chart, an inline \`chart\` fence or a Markdown table), not an A2UI surface. Use an A2UI Chart or Table when it sits inside a surface that also has controls, and RichOutput for the advanced profiles listed below.

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
- **Alert**: Notification with \`title\`, \`message\`, and \`variant\` (info, success, warning, error)

### Input Components
- **Button**: Clickable with \`text\`, \`action\`, and optional \`variant\`; the click comes back to you (see Interaction)
- **TextField**: Single-line input with \`value\`, \`label\`, \`placeholder\`
- **TextArea**: Multi-line input with \`value\`, \`label\`, \`rows\`
- **Select**: Dropdown with \`value\`, \`label\`, \`options\` array
- **Checkbox**: Toggle with \`checked\`, \`label\`
- **Radio**: Single radio button with \`value\`, \`label\`, optional \`checked\`
- **RadioGroup**: Single-choice group with \`value\`, \`options\` (\`{ value, label }\` array), optional \`label\` and \`orientation\` ("horizontal" | "vertical")
- **Slider**: Range input with \`value\`, \`min\`, \`max\`, \`step\`, \`label\`

### Data Components
- **Table**: Data table with \`columns\` (key, header) and \`data\` (row objects or a path)
- **List**: Component IDs in \`children\`, or \`template\` with \`dataPath\` and \`itemId\`
- **Chart**: Visualization with \`chartType\` (line, bar, pie, area, scatter, radar, donut), \`data\`, \`xKey\`, and \`yKeys\`

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

## Interaction: buttons and forms come back to you

In a chat, a **Button** click, a **FormGroup** submit, or a **Link** with an \`action\` is sent to you as the user's next message: the control's label, then an \`a2ui-action\` code block with \`surfaceId\`, \`componentId\`, \`componentType\`, \`action\`, any action \`data\`, and the surface's current \`dataModel\` (so every input bound to a data path arrives with it). Answer it like any user message, usually with an updated or new surface.

- Give actions you want back descriptive names (\`search_flights\`, \`confirm_booking\`).
- These names belong to built-in mini-app logic, run inside the surface and never reach you: ${A2UI_LOCAL_ACTION_NAMES.map((name) => `\`${name}\``).join(", ")}.
- Selecting table rows, clicking chart points, paging, switching tabs and typing do not message you; their state arrives with the next button press.
- A Link opens only \`https:\`, \`http:\` and \`mailto:\` targets; give it an \`action\` for anything else. Images load only from \`https:\`/\`http:\` or \`data:image/\` sources.

## Computed Values (no extra turn)

For values derived from other fields (totals, conversions, percentages, conditional labels), declare a top-level \`computed\` map next to \`dataModel\` instead of asking the user to press a button. The host recomputes it after every change:

\`\`\`json
"computed": {
  "/total": { "op": "multiply", "args": [{ "path": "/qty" }, { "path": "/price" }] },
  "/totalText": { "op": "currency", "args": [{ "path": "/total" }, "¥", 2] }
}
\`\`\`

Keys are the JSON Pointer each result is written to; bind components to that path as usual. \`args\` are literals, \`{ "path": … }\`, or nested \`{ "op", "args" }\`. Declarations run in order, so a later one can read an earlier one; a declaration that reads its own target or a later one is rejected, and \`concat\` results stop at ${A2UI_COMPUTED_LIMITS.text.toLocaleString("en-US")} characters. Text-field strings count as numbers and empty fields as 0; an impossible result (division by zero, non-numeric input) becomes \`null\`. Operators: ${A2UI_COMPUTED_OPS.map((op) => `\`${op}\``).join(", ")}. Over MCP, pass the same map as \`computed\` on \`a2ui_create_surface\` or \`a2ui_data_model_update\` (\`null\` removes one).

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

Remember: Only use A2UI when it genuinely improves the user experience. For simple text responses, regular markdown is preferred.` +
    "\n\n## Complete standard catalog starting descriptors\n" +
    "These examples come from the editor's component factories. Use unique IDs and update child references together. Bind values to dataModel paths. Optional fields are not exhaustively listed here.\n" +
    getStandardComponentTypes()
      .map((type) =>
        JSON.stringify({
          component: type,
          example: createA2UIComponentBundle(type, "example").components,
          enums: getA2UIEnumPropertyDefinitions(type),
        })
      )
      .join("\n"),
})

/**
 * The guidance text build-options appends. An inspect-only entry with no
 * placeholders renders to its body, so this is exactly what the Prompt Center
 * shows; it is a module constant because build-options reads it as one, and
 * no override can change it.
 */
export const A2UI_SYSTEM_PROMPT: string = A2UI_PROTOCOL_PROMPT.defaultBody
