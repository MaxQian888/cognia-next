# [Bug name] Fix Proposal

## 1. Problem

- **Symptom**: [the user-visible abnormal behavior]
- **Scope**: [affected features, pages, or components]

## 2. Analysis

- **Root cause**: [the technical reason, in depth]
- **Current architecture**: [optional — Mermaid diagram of the module's data flow; apply the mermaid-visualizer skill's rules]

  ```mermaid
  graph TD;
      A[User action] --> B{{Data processing}};
      B --> C[API request];
      C --> D[Component render];
  ```

## 3. Fix

- **Files to modify**:
  - `[full file path]`
- **Core changes**: [key modifications as code snippets — show only the changed parts]
- **Other files**:
  - `[paths of other files related to this defect — reading them helps understand and fix it]`
