---
"cognia-next": minor
---

Complete the Unified Plan Execution Hub's wiring: plan `approval_gate` steps are now answerable (gate dialogs moved to the app root and register themselves before blocking), the agent can author and update plans itself via the new `create_plan` / `update_plan` tools, the plan composer can create every step kind (delegation, tool, MCP, sub-workflow, approval), plans sync to the companion and can be approved remotely, plan lifecycle posts notification-center rows with working actions, `/plan to-workflow` and `/plan from-workflow` convert between plans and saved workflows, plugins get `ctx.plans` and external agents get `plan_list` / `plan_run`, and the plan visual preset now also styles the live tracker (which the unified runs detail finally shows).
