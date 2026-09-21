# [Refactor name] Technical Proposal

## 1. Background

- **Objective**: [what this refactor solves — readability, performance, architecture, tech debt]
- **Modules in scope**: [core modules, components, or files to refactor]
- **Current state**: [the problems in the existing code]

## 2. Approach

- **Overall strategy**: [refactor strategy and main steps]
- **Core changes**: [key changes as bullets or pseudocode, before/after contrast]
- **Architecture/design changes**: [optional — Mermaid diagram or text describing before/after; apply the mermaid-visualizer skill's rules]

  ```mermaid
  graph TD;
      subgraph Before
          A --> B;
      end
      subgraph After
          A' --> C';
      end
  ```

## 3. Details

[Per-module: files touched and what changed]

### [Module name]

- **Main changes**: [concrete changes, before/after comparison]
- **Design rationale**: [required for extracted shared modules]
- **File changes**:
  - **Modified**: [paths]
  - **Added**: [paths]
  - **Deleted**: [paths]

## 4. Impact and risk

- **Affected features**: [business features or user scenarios this may affect]
- **Potential risks**: [regressions, performance, compatibility]
- **Mitigations**: [unit tests, staged rollout, rollback plan]

## 5. Verification

- **Strategy**: [how the refactor's correctness and effect are verified]
- **Key checks**:
  - Expected code reduction achieved
  - All existing features still work
  - New-file import paths are correct
  - New files carry only the comments that are necessary
