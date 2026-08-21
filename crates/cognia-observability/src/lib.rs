pub mod diagnostic_package;
pub mod diagnostic_submit;
pub mod event;
pub mod log_query;
pub mod privacy;
pub mod recovery;
// ADR-0067 Tier C — the recovery *runtime* (persistence, controller,
// process-global handle) moved in from `app_lib`. It is tauri-free; the
// 5 `#[tauri::command]` shells stay app-side in `src-tauri/src/recovery/`
// so this crate keeps no tauri dep (cognia-cli links it headless).
pub mod recovery_runtime;
pub mod recovery_store;
pub mod spool;
pub mod writer;

pub use diagnostic_package::{
    create_diagnostic_package, validate_diagnostic_package, AttachmentInput, AttachmentKind,
    DiagnosticManifestV1, DiagnosticPackageInput, DiagnosticPackageValidation, PackageError,
};
pub use diagnostic_submit::{
    build_installation_proof_body, count_events, delete_incident, exchange_installation_grant,
    fetch_receipt, installation_key_path, read_package_parts, submit_package, withdraw_consent,
    DiagnosticTransport, HttpRequest, HttpResponse, InstallationIdentity, PackagePart,
    SubmissionReceipt, SubmissionRequest, SubmissionTarget, SubmitError, INSTALLATION_KEY_FILE,
};
pub use event::{
    create_traceparent, EventError, ObservabilityCapturePolicy, ObservabilityCorrelation,
    ObservabilityDelivery, ObservabilityEventKind, ObservabilityEventV1, ObservabilityPayload,
    ObservabilityPrivacy, ObservabilityRuntime, ObservabilityScope, ObservabilitySeverity,
    OBSERVABILITY_EVENT_V1_SCHEMA,
};
pub use log_query::{
    list_log_dir, query_log_dir, NativeLogEntry, NativeLogFile, NativeLogFileInfo, NativeLogQuery,
    NativeLogQueryResult,
};
pub use privacy::{
    apply_observability_privacy, create_local_debug_capture_session,
    scan_high_confidence_credentials, ClientPrivacyManifest, CredentialScanResult,
    HighConfidenceCredentialFinding, HighConfidenceCredentialKind, LocalDebugCaptureSession,
    PrivacyApplicationOptions, CLIENT_PRIVACY_MANIFEST_V1,
};
pub use recovery::{
    CheckpointResult, CheckpointStatus, ChildAction, RecoveryAuditEntry, RecoveryMode,
    RecoveryStateV1, RecoverySubsystem, RendererAction, RendererReloadBudget, HEALTH_WINDOW_MS,
    MAX_AUDIT_ENTRIES, MAX_CHILD_RESTARTS, RECOVERY_ORDER, RENDERER_RELOAD_WINDOW_MS,
};
pub use recovery_store::{RecoveryStore, RecoveryStoreError};
pub use spool::{
    durability_for, DrainResult, DurabilityTier, FileSpool, SpoolCapacityReason,
    SpoolEnqueueResult, SpoolError, SpoolLimits, SpoolRecord, SpoolStats,
};
pub use writer::{EventRequest, ObservabilityWriter, WriteOutcome, WriterClock, WriterIdentity};
