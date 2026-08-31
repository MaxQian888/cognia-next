import type {
  EvalEnvironmentCompatibility,
  EvalPreflightIssue,
  EvalPreflightResult,
  EvalProject,
  EvalVariant,
} from "./types"
import { evaluateJudgeCalibration } from "./judging"

const issue = (
  code: EvalPreflightIssue["code"],
  message: string,
  variantId?: string,
  severity: EvalPreflightIssue["severity"] = "error"
): EvalPreflightIssue => ({ code, severity, message, ...(variantId ? { variantId } : {}) })

function supportsDataset(project: EvalProject, variant: EvalVariant): boolean {
  return project.dataset.requiredModalities.every((capability) =>
    variant.capabilities.includes(capability)
  )
}

export function runProjectPreflight(
  project: EvalProject,
  environment?: EvalEnvironmentCompatibility
): EvalPreflightResult {
  const issues: EvalPreflightIssue[] = []
  if (project.dataset.caseIds.length === 0) {
    issues.push(issue("DATASET_EMPTY", "Select a dataset containing at least one case"))
  }
  const compatibleVariants = project.variants.filter((variant) => {
    if (!variant.available) {
      issues.push(issue("VARIANT_UNAVAILABLE", `${variant.name} is unavailable`, variant.id))
      return false
    }
    if (!variant.credentialReady) {
      issues.push(
        issue("CREDENTIAL_MISSING", `${variant.name} credentials are unavailable`, variant.id)
      )
      return false
    }
    if (variant.runtimeReady === false) {
      issues.push(
        issue("RUNTIME_UNAVAILABLE", `${variant.name} runtime is unavailable`, variant.id)
      )
      return false
    }
    if (!supportsDataset(project, variant)) {
      issues.push(
        issue(
          "VARIANT_INCOMPATIBLE",
          `${variant.name} cannot process the common case set`,
          variant.id
        )
      )
      return false
    }
    if (!variant.isLocal && !variant.price) {
      issues.push(issue("PRICE_REQUIRED", `${variant.name} requires a price override`, variant.id))
    }
    return true
  })

  if (compatibleVariants.length < 2) {
    issues.push(issue("TOO_FEW_VARIANTS", "At least two compatible variants are required"))
  }
  if (!project.budget.confirmed || project.budget.hardCap <= 0) {
    issues.push(
      issue("BUDGET_CONFIRMATION_REQUIRED", "Confirm a positive hard budget before dispatch")
    )
  }
  if (!environment) {
    issues.push(
      issue("ENVIRONMENT_CHECK_REQUIRED", "Run the environment compatibility check before dispatch")
    )
  } else if (environment.storage.status === "insufficient") {
    issues.push(
      issue(
        "DISK_QUOTA_INSUFFICIENT",
        "Available storage cannot hold the reserved evaluation artifacts"
      )
    )
  } else if (environment.storage.status === "unknown") {
    issues.push(
      issue(
        "DISK_QUOTA_UNKNOWN",
        "Storage quota could not be measured; monitor local storage during the run",
        undefined,
        "warning"
      )
    )
  }
  if (
    project.decisionPolicy.dimensions.length === 0 ||
    project.decisionPolicy.dimensions.some(
      (dimension) => !Number.isFinite(dimension.weight) || dimension.weight < 0
    ) ||
    project.decisionPolicy.dimensions.every((dimension) => dimension.weight === 0)
  ) {
    issues.push(
      issue(
        "DECISION_WEIGHT_INVALID",
        "Decision dimensions require finite non-negative weights with a positive total"
      )
    )
  }
  if (project.decisionPolicy.constraints.some((constraint) => !Number.isFinite(constraint.value))) {
    issues.push(
      issue("DECISION_CONSTRAINT_INVALID", "Decision constraint values must be finite numbers")
    )
  }
  if (
    !Number.isFinite(project.decisionPolicy.confidenceLevel) ||
    project.decisionPolicy.confidenceLevel <= 0 ||
    project.decisionPolicy.confidenceLevel >= 1
  ) {
    issues.push(issue("CONFIDENCE_LEVEL_INVALID", "Confidence level must be between 0 and 1"))
  }
  if (
    !Number.isInteger(project.decisionPolicy.minimumEffectiveCases) ||
    project.decisionPolicy.minimumEffectiveCases < 1
  ) {
    issues.push(
      issue("MINIMUM_CASES_INVALID", "Minimum effective cases must be a positive integer")
    )
  }
  if (!Number.isInteger(project.retentionDays) || project.retentionDays < 1) {
    issues.push(issue("RETENTION_INVALID", "Evidence retention must be a positive day count"))
  }
  if (project.decisionPolicy.formal) {
    if (project.dataset.holdoutCaseIds.length < project.decisionPolicy.minimumEffectiveCases) {
      issues.push(issue("HOLDOUT_TOO_SMALL", "Formal recommendations require enough holdout cases"))
    }
    if (
      !project.judgePolicy.enabled ||
      !project.judgePolicy.providerId ||
      !project.judgePolicy.modelId
    ) {
      issues.push(issue("JUDGE_REQUIRED", "Formal subjective scoring requires a judge"))
    } else {
      if (!project.judgePolicy.isLocal && !project.judgePolicy.price) {
        issues.push(issue("JUDGE_PRICE_REQUIRED", "Cloud judges require a price override"))
      }
      if (!project.judgePolicy.secondJudgeProviderId || !project.judgePolicy.secondJudgeModelId) {
        issues.push(issue("SECOND_JUDGE_REQUIRED", "Formal judging requires a second judge"))
      } else {
        if (!project.judgePolicy.secondJudgeIsLocal && !project.judgePolicy.secondJudgePrice) {
          issues.push(
            issue("SECOND_JUDGE_PRICE_REQUIRED", "Cloud second judges require a price override")
          )
        }
        const secondMatchesPrimary =
          project.judgePolicy.secondJudgeProviderId === project.judgePolicy.providerId &&
          project.judgePolicy.secondJudgeModelId === project.judgePolicy.modelId
        const secondMatchesTarget = compatibleVariants.some(
          (variant) =>
            variant.providerId === project.judgePolicy.secondJudgeProviderId &&
            variant.modelId === project.judgePolicy.secondJudgeModelId
        )
        if (secondMatchesPrimary || secondMatchesTarget) {
          issues.push(
            issue(
              "SECOND_JUDGE_NOT_INDEPENDENT",
              "The second judge must be independent of the primary judge and targets"
            )
          )
        }
      }
      const judgeMatchesTarget = compatibleVariants.some(
        (variant) =>
          variant.providerId === project.judgePolicy.providerId &&
          variant.modelId === project.judgePolicy.modelId
      )
      if (judgeMatchesTarget) {
        issues.push(
          issue("JUDGE_NOT_INDEPENDENT", "The judge must be independent of target variants")
        )
      }
      if (
        !project.judgePolicy.calibrated ||
        !evaluateJudgeCalibration(project.judgePolicy).passed
      ) {
        issues.push(issue("JUDGE_CALIBRATION_FAILED", "Judge calibration does not meet policy"))
      }
    }
  }
  if (
    project.dataset.requiredModalities.some((capability) => capability !== "text") &&
    (project.dataset.mediaClearance ?? project.privacyPolicy.mediaClearance) === "local-only" &&
    compatibleVariants.some((variant) => !variant.isLocal)
  ) {
    issues.push(issue("MEDIA_CLEARANCE_REQUIRED", "Cloud media requires scan or manual clearance"))
  }

  return {
    ok: issues.every((item) => item.severity !== "error"),
    issues,
    compatibleVariantIds: compatibleVariants.map((variant) => variant.id),
    effectiveCaseIds: [
      ...(project.decisionPolicy.formal ? project.dataset.holdoutCaseIds : project.dataset.caseIds),
    ],
  }
}
