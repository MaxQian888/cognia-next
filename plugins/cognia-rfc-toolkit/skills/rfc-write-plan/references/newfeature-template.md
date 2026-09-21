# [Feature name] Implementation Proposal

## 1. Requirement [required]

- **Description**: [the feature's core purpose and business value]
- **Goals**: [measurable outcomes or expected effects]

## 2. Technical approach [required]

- **Overall strategy**: [high-level strategy and staged plan]
- **Architecture**: [optional — Mermaid or text describing module relationships; apply the mermaid-visualizer skill's rules]

  ```mermaid
  graph TD;
      A[User action] --> B{{Data processing}};
      B --> C[API request];
      C --> D[Component render];
  ```

## 3. Prerequisites [optional]

[Work that must happen before development — e.g. service interface updates, database design, dependency upgrades — in the order they must run. Add only what applies.]

## 4. Implementation details

### 4.1 Module breakdown [required]

[Design per business module. MUST follow the user's own module decomposition when provided — never drop or rewrite their module descriptions.]

<!--
#### 4.1.1 [Module name — a whole page or one large feature block, e.g. "X page", "X module", "X entry"; if the user already decomposed the feature, reuse their split and note iterate-vs-new]
- **Functional description**: [detailed changes — new fields, deletions, ordering — never drop or rewrite the user's stated requirements]
- **Approach**: [use pseudocode for logic that is hard to describe; show only what changes; note any existing implementation or best practice referenced]
- **Design references**: [optional — design/mock links from the user's input, listed in order, each with the requirement it maps to]
- **Dependencies**:
    - **Components**: [internal/external component libraries and component names to use]
    - **Libraries**: [project base libraries and the APIs to use]
    - **APIs**: [backend APIs to integrate]
    - **Routes**: [optional — routes to add or change: path, method, permission]
    - **Other**: [config files, env vars, static-asset links]
- **File changes**: [paths to add/modify/delete, relative to the repo root; modified/deleted paths must actually exist]
- **Other files**: [optional — related files worth reading to understand the feature]
-->

### 4.2 Component design [optional]

[Non-standard components that must be built — evaluate reuse first, or note candidates for promotion to shared components; where a standard component needs extension, note the gap.]

## 5. Appendix [required]

- [Dependent component 1: API notes — props, events]
- [Dependent library 1: API notes — inputs, outputs, error handling]
- [API 1: contract — request params, response shape, as provided by the user or confirmed from API definitions]
