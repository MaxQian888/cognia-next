/**
 * Ultracode `pattern.*` node executors (ADR-0022 addendum). Importing this
 * module registers all six higher-order Agent-Team pattern nodes with the
 * workflow node registry via their module-load side effects. `runTeamLifecycle`
 * imports this before any ultracode run so the orchestrator can resolve them.
 */

export { multiModalSweepNode, MULTI_MODAL_SWEEP_KIND } from "./multi-modal-sweep"
export { loopUntilDryNode, LOOP_UNTIL_DRY_KIND } from "./loop-until-dry"
export { adversarialVerifyNode, ADVERSARIAL_VERIFY_KIND } from "./adversarial-verify"
export { judgePanelNode, JUDGE_PANEL_KIND } from "./judge-panel"
export { completenessCriticNode, COMPLETENESS_CRITIC_KIND } from "./completeness-critic"
export { synthesizeNode, SYNTHESIZE_KIND } from "./synthesize"
