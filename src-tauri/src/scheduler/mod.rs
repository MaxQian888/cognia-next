//! System Scheduler Module
//!
//! Provides cross-platform system-level task scheduling with support for:
//! - Windows Task Scheduler
//! - macOS launchd
//! - Linux systemd
//!
//! Features:
//! - Script execution in sandbox
//! - Cron-style scheduling
//! - On-boot and on-logon triggers
//! - Risk assessment and confirmation
//! - Admin elevation handling

pub mod commands;
pub mod daemon;
pub mod error;
pub mod metadata_store;
pub mod service;
pub mod types;

#[cfg(target_os = "windows")]
pub mod windows;

#[cfg(target_os = "macos")]
pub mod macos;

#[cfg(target_os = "linux")]
pub mod linux;

use chrono::{Duration as ChronoDuration, Utc};
use log::{debug, info, warn};
use std::collections::HashMap;
use std::path::PathBuf;
use once_cell::sync::OnceCell;
use std::sync::Arc;
use tokio::sync::RwLock;

pub use error::{Result, SchedulerError};
use metadata_store::SchedulerMetadataStore;
pub use service::SystemScheduler;
pub use types::*;

pub use daemon::{AlarmDaemon, TaskDueEmitter};

/// AppHandle-bound `TaskDueEmitter` — wraps `tauri::Emitter::emit` so the alarm
/// daemon can fire `scheduler:task-due` events without holding a `&AppHandle`
/// (which doesn't satisfy the daemon's `'static` bound). Mirrors
/// `crate::workflow::AppHandleEmitter`.
pub struct AppHandleTaskDueEmitter {
    pub handle: tauri::AppHandle,
}

impl TaskDueEmitter for AppHandleTaskDueEmitter {
    fn emit(&self, event: TaskDueEvent) {
        if let Err(err) = tauri::Emitter::emit(&self.handle, "scheduler:task-due", event) {
            warn!("scheduler:task-due emit failed: {err}");
        }
    }
}

#[derive(Clone)]
#[allow(dead_code)]
enum PendingOperation {
    Create {
        input: CreateSystemTaskInput,
    },
    Update {
        task_id: SystemTaskId,
        input: CreateSystemTaskInput,
    },
    Delete {
        task_id: SystemTaskId,
    },
    Enable {
        task_id: SystemTaskId,
    },
    RunNow {
        task_id: SystemTaskId,
    },
}

#[derive(Clone)]
struct PendingConfirmationRecord {
    request: TaskConfirmationRequest,
    operation: PendingOperation,
}

/// Global scheduler state.
///
/// Both the platform scheduler and the SQLite metadata store are built
/// **lazily on first use**, not in `new()`. Construction is expensive and
/// used to run on the synchronous Tauri startup path: `create_platform_scheduler`
/// shells out to `schtasks.exe` / `launchctl` / `systemctl` to probe
/// availability + elevation, and the metadata store opens a SQLite file.
/// Nothing at app boot calls a `scheduler_*` command (the renderer's
/// scheduler UI is Dexie-backed), so deferring keeps that subprocess probe
/// and DB open off the startup critical path — they pay their cost on the
/// first system-scheduler command instead, on a tokio worker thread.
pub struct SchedulerState {
    scheduler: OnceCell<Arc<dyn SystemScheduler>>,
    metadata_db_path: Option<PathBuf>,
    metadata_store: OnceCell<Option<SchedulerMetadataStore>>,
    /// Pending confirmations keyed by confirmation_id
    pending_confirmations: RwLock<HashMap<String, PendingConfirmationRecord>>,
    /// In-process alarm daemon driving headless timing for the app scheduler.
    /// Installed (built + spawned) in the Tauri `setup` closure once an
    /// AppHandle exists; `None` in web mode or before install.
    alarm: OnceCell<AlarmDaemon>,
}

impl SchedulerState {
    /// Create a new scheduler state. Cheap by design — the platform probe and
    /// metadata-store open are deferred to first access (see the type docs).
    pub fn new(metadata_db_path: Option<PathBuf>) -> Self {
        Self {
            scheduler: OnceCell::new(),
            metadata_db_path,
            metadata_store: OnceCell::new(),
            pending_confirmations: RwLock::new(HashMap::new()),
            alarm: OnceCell::new(),
        }
    }

    /// Build + spawn the in-process alarm daemon with the given emitter and
    /// store it for `arm`/`disarm` access. Idempotent — a second call is
    /// ignored. Called from the Tauri `setup` closure (see `lib.rs`).
    pub fn install_alarm(&self, emitter: Arc<dyn TaskDueEmitter>) {
        let daemon = AlarmDaemon::new(emitter);
        if self.alarm.set(daemon.clone()).is_ok() {
            daemon.spawn();
        }
    }

    /// The installed alarm daemon, if any. `None` in web mode / before install.
    pub fn alarm(&self) -> Option<&AlarmDaemon> {
        self.alarm.get()
    }

    /// Test-only: install the alarm daemon WITHOUT spawning its run loop. The
    /// production `install_alarm` spawns an infinite loop on Tauri's global
    /// runtime, which would keep the test binary alive at exit. The loop itself
    /// is covered by `daemon::tests` via `tokio::spawn`; here we only need the
    /// cell wiring so `arm`/`disarm` are observable.
    #[cfg(test)]
    pub fn install_alarm_no_spawn(&self, emitter: Arc<dyn TaskDueEmitter>) {
        let _ = self.alarm.set(AlarmDaemon::new(emitter));
    }

    /// Lazily build the platform scheduler on first access. The availability /
    /// elevation probe (a blocking subprocess spawn) runs here, off the
    /// startup path.
    fn scheduler(&self) -> &Arc<dyn SystemScheduler> {
        self.scheduler.get_or_init(|| {
            let scheduler = Self::create_platform_scheduler();
            info!(
                "Scheduler state initialized: os={}, backend={}",
                scheduler.capabilities().os,
                scheduler.capabilities().backend
            );
            scheduler
        })
    }

    /// Lazily open the SQLite metadata store on first access. A failed open
    /// (or absent path) yields `None` — same posture as before, just deferred.
    fn metadata(&self) -> Option<&SchedulerMetadataStore> {
        self.metadata_store
            .get_or_init(|| {
                let path = self.metadata_db_path.clone()?;
                match SchedulerMetadataStore::new(path) {
                    Ok(store) => Some(store),
                    Err(error) => {
                        warn!("Failed to initialize scheduler metadata store: {}", error);
                        None
                    }
                }
            })
            .as_ref()
    }

    /// Create the appropriate scheduler for the current platform
    #[cfg(target_os = "windows")]
    fn create_platform_scheduler() -> Arc<dyn SystemScheduler> {
        Arc::new(windows::WindowsScheduler::new())
    }

    #[cfg(target_os = "macos")]
    fn create_platform_scheduler() -> Arc<dyn SystemScheduler> {
        Arc::new(macos::MacOSScheduler::new())
    }

    #[cfg(target_os = "linux")]
    fn create_platform_scheduler() -> Arc<dyn SystemScheduler> {
        Arc::new(linux::LinuxScheduler::new())
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    fn create_platform_scheduler() -> Arc<dyn SystemScheduler> {
        Arc::new(NoopScheduler::new())
    }

    /// Get scheduler capabilities (with trigger_capabilities populated from platform impl)
    pub fn capabilities(&self) -> SchedulerCapabilities {
        self.scheduler().capabilities()
    }

    /// Validate trigger translation fidelity on the active platform
    pub fn validate_trigger_translation(
        &self,
        trigger: &SystemTaskTrigger,
    ) -> TranslationValidation {
        self.scheduler().validate_trigger_translation(trigger)
    }

    /// Check if scheduler is available
    pub fn is_available(&self) -> bool {
        self.scheduler().is_available()
    }

    /// Check if running with elevated privileges
    pub fn is_elevated(&self) -> bool {
        self.scheduler().is_elevated()
    }

    /// Check if a task requires admin privileges (delegates to platform scheduler)
    pub fn requires_admin(&self, task: &SystemTask) -> bool {
        self.scheduler().requires_admin(task)
    }

    fn is_placeholder_task(task: &SystemTask) -> bool {
        matches!(task.trigger, SystemTaskTrigger::Interval { seconds: 0 })
            && matches!(
                task.action,
                SystemTaskAction::RunCommand { ref command, .. } if command.is_empty()
            )
    }

    fn make_temp_task(
        id: String,
        input: &CreateSystemTaskInput,
        status: SystemTaskStatus,
        metadata_state: TaskMetadataState,
    ) -> SystemTask {
        SystemTask {
            id,
            name: input.name.clone(),
            description: input.description.clone(),
            trigger: input.trigger.clone(),
            action: input.action.clone(),
            run_level: input.run_level,
            status,
            requires_admin: false,
            tags: input.tags.clone(),
            created_at: None,
            updated_at: None,
            last_run_at: None,
            next_run_at: None,
            last_result: None,
            metadata_state,
        }
    }

    fn expires_at_iso() -> String {
        (Utc::now() + ChronoDuration::hours(24)).to_rfc3339()
    }

    fn now_iso() -> String {
        Utc::now().to_rfc3339()
    }

    fn build_confirmation(
        &self,
        task: &SystemTask,
        operation: TaskOperation,
        target_task_id: Option<SystemTaskId>,
        confirmation_id: String,
    ) -> TaskConfirmationRequest {
        let requires_admin = task.check_requires_admin() || self.scheduler().requires_admin(task);
        TaskConfirmationRequest {
            confirmation_id,
            task_id: Some(task.id.clone()),
            target_task_id,
            operation,
            risk_level: task.calculate_risk_level(),
            requires_admin,
            warnings: task.generate_warnings(),
            details: TaskConfirmationDetails {
                task_name: task.name.clone(),
                action_summary: Some(Self::summarize_action(&task.action)),
                trigger_summary: Some(Self::summarize_trigger(&task.trigger)),
                script_preview: Self::get_script_preview(&task.action),
            },
            created_at: Self::now_iso(),
            expires_at: Self::expires_at_iso(),
        }
    }

    async fn store_pending_confirmation(
        &self,
        request: TaskConfirmationRequest,
        operation: PendingOperation,
    ) -> TaskConfirmationRequest {
        let confirmation_id = request.confirmation_id.clone();
        let mut pending = self.pending_confirmations.write().await;
        pending.insert(
            confirmation_id.clone(),
            PendingConfirmationRecord {
                request: request.clone(),
                operation,
            },
        );
        debug!(
            "Stored pending confirmation: confirmation_id={}, operation={:?}, target_task_id={}",
            confirmation_id,
            request.operation,
            request.target_task_id.clone().unwrap_or_default()
        );
        request
    }

    fn is_confirmation_expired(request: &TaskConfirmationRequest) -> bool {
        chrono::DateTime::parse_from_rfc3339(&request.expires_at)
            .map(|dt| dt.with_timezone(&Utc) < Utc::now())
            .unwrap_or(false)
    }

    async fn prune_expired_confirmations(&self) {
        let mut pending = self.pending_confirmations.write().await;
        let expired_ids = pending
            .iter()
            .filter_map(|(id, record)| {
                if Self::is_confirmation_expired(&record.request) {
                    Some(id.clone())
                } else {
                    None
                }
            })
            .collect::<Vec<_>>();
        for confirmation_id in expired_ids {
            pending.remove(&confirmation_id);
            debug!("Expired confirmation pruned: {}", confirmation_id);
        }
    }

    fn merge_platform_with_metadata(
        platform_task: &SystemTask,
        metadata_task: &SystemTask,
    ) -> SystemTask {
        let mut merged = metadata_task.clone();
        merged.id = platform_task.id.clone();
        if !platform_task.name.trim().is_empty() {
            merged.name = platform_task.name.clone();
        }
        merged.status = platform_task.status;
        merged.last_run_at = platform_task.last_run_at.clone();
        merged.next_run_at = platform_task.next_run_at.clone();
        merged.last_result = platform_task.last_result.clone();
        merged.metadata_state = TaskMetadataState::Full;
        merged.requires_admin = merged.check_requires_admin();
        merged
    }

    async fn enrich_task_with_metadata(&self, platform_task: SystemTask) -> SystemTask {
        if let Some(store) = self.metadata() {
            match store.get_task_metadata(&platform_task.id, Some(&platform_task.name)) {
                Ok(Some(metadata_task)) => {
                    return Self::merge_platform_with_metadata(&platform_task, &metadata_task);
                }
                Ok(None) => {}
                Err(error) => {
                    warn!(
                        "Failed loading metadata for task {}: {}",
                        platform_task.id, error
                    );
                }
            }
        }

        let mut task = platform_task;
        if Self::is_placeholder_task(&task) {
            task.metadata_state = TaskMetadataState::Degraded;
        }
        task
    }

    fn persist_task_metadata(&self, task: &SystemTask) {
        if let Some(store) = self.metadata() {
            if let Err(error) = store.upsert_task(task) {
                warn!(
                    "Failed to persist scheduler metadata for task {}: {}",
                    task.id, error
                );
            }
        }
    }

    fn delete_task_metadata(&self, task_id: &str) {
        if let Some(store) = self.metadata() {
            if let Err(error) = store.delete_task(task_id) {
                warn!(
                    "Failed deleting scheduler metadata for task {}: {}",
                    task_id, error
                );
            }
        }
    }

    /// Create a task with confirmation flow
    pub async fn create_task_with_confirmation(
        &self,
        input: CreateSystemTaskInput,
        confirmed: bool,
    ) -> Result<std::result::Result<SystemTask, TaskConfirmationRequest>> {
        let temp_task = Self::make_temp_task(
            SystemTask::generate_id(),
            &input,
            SystemTaskStatus::Enabled,
            TaskMetadataState::Full,
        );
        let requires_admin =
            temp_task.check_requires_admin() || self.scheduler().requires_admin(&temp_task);
        let risk_level = temp_task.calculate_risk_level();

        // Check if confirmation is needed
        let needs_confirmation = matches!(risk_level, RiskLevel::High | RiskLevel::Critical)
            || requires_admin
            || matches!(temp_task.action, SystemTaskAction::ExecuteScript { .. });

        if needs_confirmation && !confirmed {
            let confirmation_id = format!("confirm-{}", uuid::Uuid::new_v4());
            let confirmation =
                self.build_confirmation(&temp_task, TaskOperation::Create, None, confirmation_id);
            let confirmation = self
                .store_pending_confirmation(
                    confirmation,
                    PendingOperation::Create {
                        input: input.clone(),
                    },
                )
                .await;
            return Ok(Err(confirmation));
        }

        // Check admin requirement
        if requires_admin && !self.is_elevated() {
            return Err(SchedulerError::AdminRequired(
                "Administrator privileges required for this task".to_string(),
            ));
        }

        // Create the task
        let mut task = self.scheduler().create_task(input).await?;
        task.metadata_state = TaskMetadataState::Full;
        self.persist_task_metadata(&task);
        Ok(Ok(task))
    }

    /// Confirm a pending operation
    pub async fn confirm_task(&self, confirmation_id: &str) -> Result<Option<SystemTask>> {
        self.prune_expired_confirmations().await;
        let record = {
            let mut pending = self.pending_confirmations.write().await;
            pending.remove(confirmation_id)
        };

        let Some(record) = record else {
            return Ok(None);
        };

        if Self::is_confirmation_expired(&record.request) {
            return Err(SchedulerError::Timeout(format!(
                "Confirmation expired: {}",
                confirmation_id
            )));
        }

        debug!(
            "Executing pending confirmation: confirmation_id={}, operation={:?}, task_id={}",
            confirmation_id,
            record.request.operation,
            record
                .request
                .target_task_id
                .clone()
                .or_else(|| record.request.task_id.clone())
                .unwrap_or_default()
        );

        match record.operation {
            PendingOperation::Create { input } => {
                let mut task = self.scheduler().create_task(input).await?;
                task.metadata_state = TaskMetadataState::Full;
                self.persist_task_metadata(&task);
                Ok(Some(task))
            }
            PendingOperation::Update { task_id, input } => {
                let mut task = self.scheduler().update_task(&task_id, input).await?;
                task.metadata_state = TaskMetadataState::Full;
                self.persist_task_metadata(&task);
                Ok(Some(task))
            }
            PendingOperation::Delete { task_id } => {
                let _ = self.scheduler().delete_task(&task_id).await?;
                self.delete_task_metadata(&task_id);
                Ok(None)
            }
            PendingOperation::Enable { task_id } => {
                let _ = self.scheduler().enable_task(&task_id).await?;
                if let Some(task) = self.scheduler().get_task(&task_id).await? {
                    let enriched = self.enrich_task_with_metadata(task).await;
                    self.persist_task_metadata(&enriched);
                    Ok(Some(enriched))
                } else {
                    Ok(None)
                }
            }
            PendingOperation::RunNow { task_id } => {
                let _ = self.scheduler().run_task_now(&task_id).await?;
                if let Some(task) = self.scheduler().get_task(&task_id).await? {
                    let enriched = self.enrich_task_with_metadata(task).await;
                    if enriched.metadata_state == TaskMetadataState::Full {
                        self.persist_task_metadata(&enriched);
                    }
                    Ok(Some(enriched))
                } else {
                    Ok(None)
                }
            }
        }
    }

    /// Cancel a pending confirmation
    pub async fn cancel_confirmation(&self, confirmation_id: &str) -> bool {
        self.prune_expired_confirmations().await;
        let mut pending = self.pending_confirmations.write().await;
        pending.remove(confirmation_id).is_some()
    }

    /// Get all pending confirmations
    pub async fn get_pending_confirmations(&self) -> Vec<TaskConfirmationRequest> {
        self.prune_expired_confirmations().await;
        let pending = self.pending_confirmations.read().await;
        let mut items: Vec<TaskConfirmationRequest> = pending
            .values()
            .map(|entry| entry.request.clone())
            .collect();
        items.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        items
    }

    /// Update a task
    pub async fn update_task(
        &self,
        id: &str,
        input: CreateSystemTaskInput,
        confirmed: bool,
    ) -> Result<std::result::Result<SystemTask, TaskConfirmationRequest>> {
        let temp_task = Self::make_temp_task(
            id.to_string(),
            &input,
            SystemTaskStatus::Enabled,
            TaskMetadataState::Full,
        );
        let requires_admin =
            temp_task.check_requires_admin() || self.scheduler().requires_admin(&temp_task);
        let risk_level = temp_task.calculate_risk_level();

        let needs_confirmation = matches!(risk_level, RiskLevel::High | RiskLevel::Critical)
            || requires_admin
            || matches!(temp_task.action, SystemTaskAction::ExecuteScript { .. });

        if needs_confirmation && !confirmed {
            let confirmation_id = format!("confirm-{}", uuid::Uuid::new_v4());
            let confirmation = self.build_confirmation(
                &temp_task,
                TaskOperation::Update,
                Some(id.to_string()),
                confirmation_id,
            );
            let confirmation = self
                .store_pending_confirmation(
                    confirmation,
                    PendingOperation::Update {
                        task_id: id.to_string(),
                        input: input.clone(),
                    },
                )
                .await;
            return Ok(Err(confirmation));
        }

        if requires_admin && !self.is_elevated() {
            return Err(SchedulerError::AdminRequired(
                "Administrator privileges required for this task".to_string(),
            ));
        }

        let mut task = self.scheduler().update_task(id, input).await?;
        task.metadata_state = TaskMetadataState::Full;
        self.persist_task_metadata(&task);
        Ok(Ok(task))
    }

    /// Delete a task
    pub async fn delete_task(&self, id: &str) -> Result<bool> {
        let deleted = self.scheduler().delete_task(id).await?;
        if deleted {
            self.delete_task_metadata(id);
        }
        Ok(deleted)
    }

    /// Get a task by ID
    pub async fn get_task(&self, id: &str) -> Result<Option<SystemTask>> {
        match self.scheduler().get_task(id).await? {
            Some(task) => {
                let enriched = self.enrich_task_with_metadata(task).await;
                if enriched.metadata_state == TaskMetadataState::Full {
                    self.persist_task_metadata(&enriched);
                }
                Ok(Some(enriched))
            }
            None => {
                if let Some(store) = self.metadata() {
                    if let Some(mut metadata_task) = store.get_task_metadata(id, None)? {
                        metadata_task.status = SystemTaskStatus::Unknown;
                        metadata_task.metadata_state = TaskMetadataState::Degraded;
                        metadata_task.requires_admin = metadata_task.check_requires_admin();
                        return Ok(Some(metadata_task));
                    }
                }
                Ok(None)
            }
        }
    }

    /// List all tasks
    pub async fn list_tasks(&self) -> Result<Vec<SystemTask>> {
        let tasks = self.scheduler().list_tasks().await?;
        let mut enriched = Vec::with_capacity(tasks.len());
        for task in tasks {
            let merged = self.enrich_task_with_metadata(task).await;
            if merged.metadata_state == TaskMetadataState::Full {
                self.persist_task_metadata(&merged);
            }
            enriched.push(merged);
        }
        Ok(enriched)
    }

    /// Enable a task
    pub async fn enable_task(&self, id: &str) -> Result<bool> {
        self.scheduler().enable_task(id).await
    }

    /// Disable a task
    pub async fn disable_task(&self, id: &str) -> Result<bool> {
        self.scheduler().disable_task(id).await
    }

    /// Run a task immediately
    pub async fn run_task_now(&self, id: &str) -> Result<TaskRunResult> {
        self.scheduler().run_task_now(id).await
    }

    /// Request admin elevation
    pub async fn request_elevation(&self) -> Result<bool> {
        self.scheduler().request_elevation().await
    }

    /// Summarize an action for display
    fn summarize_action(action: &SystemTaskAction) -> String {
        match action {
            SystemTaskAction::ExecuteScript { language, .. } => {
                format!("Execute {} script", language)
            }
            SystemTaskAction::RunCommand { command, args, .. } => {
                if args.is_empty() {
                    format!("Run command: {}", command)
                } else {
                    format!("Run command: {} {}", command, args.join(" "))
                }
            }
            SystemTaskAction::LaunchApp { path, .. } => {
                format!("Launch application: {}", path)
            }
        }
    }

    /// Summarize a trigger for display
    fn summarize_trigger(trigger: &SystemTaskTrigger) -> String {
        match trigger {
            SystemTaskTrigger::Cron { expression, .. } => {
                format!("Cron schedule: {}", expression)
            }
            SystemTaskTrigger::Interval { seconds } => {
                if *seconds < 60 {
                    format!("Every {} seconds", seconds)
                } else if *seconds < 3600 {
                    format!("Every {} minutes", seconds / 60)
                } else {
                    format!("Every {} hours", seconds / 3600)
                }
            }
            SystemTaskTrigger::Once { run_at } => {
                format!("Once at {}", run_at)
            }
            SystemTaskTrigger::OnBoot { delay_seconds } => {
                if *delay_seconds > 0 {
                    format!("On system boot (after {} seconds delay)", delay_seconds)
                } else {
                    "On system boot".to_string()
                }
            }
            SystemTaskTrigger::OnLogon { user } => {
                if let Some(u) = user {
                    format!("On {} logon", u)
                } else {
                    "On user logon".to_string()
                }
            }
            SystemTaskTrigger::OnEvent { source, event_id } => {
                format!("On event {} from {}", event_id, source)
            }
        }
    }

    /// Get script preview (first few lines)
    fn get_script_preview(action: &SystemTaskAction) -> Option<String> {
        if let SystemTaskAction::ExecuteScript { code, .. } = action {
            let lines: Vec<&str> = code.lines().take(5).collect();
            let preview = lines.join("\n");
            if code.lines().count() > 5 {
                Some(format!("{}...", preview))
            } else {
                Some(preview)
            }
        } else {
            None
        }
    }
}

impl Default for SchedulerState {
    fn default() -> Self {
        Self::new(None)
    }
}

/// No-op scheduler for unsupported platforms
#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
pub struct NoopScheduler;

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
impl NoopScheduler {
    pub fn new() -> Self {
        Self
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
#[async_trait::async_trait]
impl SystemScheduler for NoopScheduler {
    fn capabilities(&self) -> SchedulerCapabilities {
        SchedulerCapabilities {
            os: std::env::consts::OS.to_string(),
            backend: "none".to_string(),
            available: false,
            can_elevate: false,
            supported_triggers: vec![],
            trigger_capabilities: vec![],
            max_tasks: 0,
        }
    }

    fn is_available(&self) -> bool {
        false
    }

    async fn create_task(&self, _input: CreateSystemTaskInput) -> Result<SystemTask> {
        Err(SchedulerError::NotAvailable(
            "System scheduler not available on this platform".to_string(),
        ))
    }

    async fn update_task(&self, _id: &str, _input: CreateSystemTaskInput) -> Result<SystemTask> {
        Err(SchedulerError::NotAvailable(
            "System scheduler not available on this platform".to_string(),
        ))
    }

    async fn delete_task(&self, _id: &str) -> Result<bool> {
        Ok(false)
    }

    async fn get_task(&self, _id: &str) -> Result<Option<SystemTask>> {
        Ok(None)
    }

    async fn list_tasks(&self) -> Result<Vec<SystemTask>> {
        Ok(vec![])
    }

    async fn enable_task(&self, _id: &str) -> Result<bool> {
        Ok(false)
    }

    async fn disable_task(&self, _id: &str) -> Result<bool> {
        Ok(false)
    }

    async fn run_task_now(&self, _id: &str) -> Result<TaskRunResult> {
        Err(SchedulerError::NotAvailable(
            "System scheduler not available on this platform".to_string(),
        ))
    }

    fn requires_admin(&self, _task: &SystemTask) -> bool {
        false
    }

    async fn request_elevation(&self) -> Result<bool> {
        Ok(false)
    }

    fn is_elevated(&self) -> bool {
        false
    }

    fn get_trigger_capabilities(&self) -> Vec<TriggerCapability> {
        vec![]
    }

    fn validate_trigger_translation(&self, _trigger: &SystemTaskTrigger) -> TranslationValidation {
        TranslationValidation {
            valid: false,
            errors: vec!["System scheduler not available on this platform".to_string()],
            warnings: vec![],
            native_representation: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use std::collections::HashMap;
    use std::sync::Mutex;

    #[derive(Default)]
    struct MockScheduler {
        tasks: Mutex<HashMap<String, SystemTask>>,
    }

    #[async_trait]
    impl SystemScheduler for MockScheduler {
        fn capabilities(&self) -> SchedulerCapabilities {
            SchedulerCapabilities {
                os: "test".to_string(),
                backend: "mock".to_string(),
                available: true,
                can_elevate: true,
                supported_triggers: vec!["interval".to_string()],
                trigger_capabilities: vec![],
                max_tasks: 0,
            }
        }

        fn is_available(&self) -> bool {
            true
        }

        async fn create_task(&self, input: CreateSystemTaskInput) -> Result<SystemTask> {
            let id = SystemTask::generate_id();
            let task = SystemTask {
                id: id.clone(),
                name: input.name,
                description: input.description,
                trigger: input.trigger,
                action: input.action,
                run_level: input.run_level,
                status: SystemTaskStatus::Enabled,
                requires_admin: false,
                tags: input.tags,
                created_at: Some(SchedulerState::now_iso()),
                updated_at: Some(SchedulerState::now_iso()),
                last_run_at: None,
                next_run_at: None,
                last_result: None,
                metadata_state: TaskMetadataState::Full,
            };
            self.tasks
                .lock()
                .expect("lock")
                .insert(id.clone(), task.clone());
            Ok(task)
        }

        async fn update_task(&self, id: &str, input: CreateSystemTaskInput) -> Result<SystemTask> {
            let mut tasks = self.tasks.lock().expect("lock");
            if !tasks.contains_key(id) {
                return Err(SchedulerError::TaskNotFound(id.to_string()));
            }
            let task = SystemTask {
                id: id.to_string(),
                name: input.name,
                description: input.description,
                trigger: input.trigger,
                action: input.action,
                run_level: input.run_level,
                status: SystemTaskStatus::Enabled,
                requires_admin: false,
                tags: input.tags,
                created_at: Some(SchedulerState::now_iso()),
                updated_at: Some(SchedulerState::now_iso()),
                last_run_at: None,
                next_run_at: None,
                last_result: None,
                metadata_state: TaskMetadataState::Full,
            };
            tasks.insert(id.to_string(), task.clone());
            Ok(task)
        }

        async fn delete_task(&self, id: &str) -> Result<bool> {
            Ok(self.tasks.lock().expect("lock").remove(id).is_some())
        }

        async fn get_task(&self, id: &str) -> Result<Option<SystemTask>> {
            Ok(self.tasks.lock().expect("lock").get(id).cloned())
        }

        async fn list_tasks(&self) -> Result<Vec<SystemTask>> {
            Ok(self
                .tasks
                .lock()
                .expect("lock")
                .values()
                .cloned()
                .collect::<Vec<_>>())
        }

        async fn enable_task(&self, _id: &str) -> Result<bool> {
            Ok(true)
        }

        async fn disable_task(&self, _id: &str) -> Result<bool> {
            Ok(true)
        }

        async fn run_task_now(&self, _id: &str) -> Result<TaskRunResult> {
            Ok(TaskRunResult {
                success: true,
                exit_code: Some(0),
                stdout: None,
                stderr: None,
                error: None,
                duration_ms: Some(1),
            })
        }

        fn requires_admin(&self, task: &SystemTask) -> bool {
            task.check_requires_admin()
        }

        async fn request_elevation(&self) -> Result<bool> {
            Ok(true)
        }

        fn is_elevated(&self) -> bool {
            true
        }

        fn get_trigger_capabilities(&self) -> Vec<TriggerCapability> {
            vec![TriggerCapability {
                trigger_type: "interval".to_string(),
                available: true,
                requires_admin: false,
                constraint_notes: vec![],
                backend_notes: vec![],
            }]
        }

        fn validate_trigger_translation(
            &self,
            _trigger: &SystemTaskTrigger,
        ) -> TranslationValidation {
            TranslationValidation {
                valid: true,
                errors: vec![],
                warnings: vec![],
                native_representation: Some("mock: test".to_string()),
            }
        }
    }

    fn build_state_with_mock() -> SchedulerState {
        // Pre-fill the lazy scheduler cell with the mock so `scheduler()`
        // returns it instead of probing the real platform backend.
        let scheduler: OnceCell<Arc<dyn SystemScheduler>> = OnceCell::new();
        let _ = scheduler.set(Arc::new(MockScheduler::default()));
        SchedulerState {
            scheduler,
            metadata_db_path: None,
            metadata_store: OnceCell::new(),
            pending_confirmations: RwLock::new(HashMap::new()),
            alarm: OnceCell::new(),
        }
    }

    fn build_state_with_mock_and_metadata(path: PathBuf) -> SchedulerState {
        let scheduler: OnceCell<Arc<dyn SystemScheduler>> = OnceCell::new();
        let _ = scheduler.set(Arc::new(MockScheduler::default()));
        SchedulerState {
            scheduler,
            metadata_db_path: Some(path),
            metadata_store: OnceCell::new(),
            pending_confirmations: RwLock::new(HashMap::new()),
            alarm: OnceCell::new(),
        }
    }

    #[test]
    fn metadata_store_opens_lazily() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("scheduler_metadata.sqlite");
        let state = build_state_with_mock_and_metadata(path.clone());
        // Construction must NOT open the SQLite file — that open used to run on
        // the synchronous Tauri startup path.
        assert!(!path.exists(), "metadata db opened before first access");
        // First metadata access opens it.
        assert!(state.metadata().is_some());
        assert!(path.exists(), "metadata db not opened on first access");
    }

    fn interval_command_input(name: &str) -> CreateSystemTaskInput {
        CreateSystemTaskInput {
            name: name.to_string(),
            description: Some("desc".to_string()),
            trigger: SystemTaskTrigger::Interval { seconds: 60 },
            action: SystemTaskAction::RunCommand {
                command: "/bin/echo".to_string(),
                args: vec!["ok".to_string()],
                working_dir: None,
                env: HashMap::new(),
            },
            run_level: RunLevel::User,
            tags: vec!["test".to_string()],
        }
    }

    fn risky_script_input(name: &str) -> CreateSystemTaskInput {
        CreateSystemTaskInput {
            name: name.to_string(),
            description: Some("script".to_string()),
            trigger: SystemTaskTrigger::Interval { seconds: 60 },
            action: SystemTaskAction::ExecuteScript {
                language: "python".to_string(),
                code: "print('x')".to_string(),
                working_dir: None,
                args: vec![],
                env: HashMap::new(),
                timeout_secs: 300,
                memory_mb: 512,
                use_sandbox: false,
            },
            run_level: RunLevel::User,
            tags: vec!["test".to_string()],
        }
    }

    #[test]
    fn fresh_state_has_no_alarm_until_installed() {
        let state = SchedulerState::new(None);
        assert!(state.alarm().is_none());
    }

    #[test]
    fn install_alarm_exposes_daemon_and_is_idempotent() {
        use super::daemon::RecordingEmitter;
        let state = SchedulerState::new(None);
        state.install_alarm_no_spawn(Arc::new(RecordingEmitter::default()));
        assert!(state.alarm().is_some());
        assert_eq!(state.alarm().map(|d| d.entry_count()), Some(0));
        // Arming through the installed daemon works.
        let future = (Utc::now() + ChronoDuration::hours(1)).timestamp_millis();
        state.alarm().expect("alarm").arm("task_1".into(), future);
        assert_eq!(state.alarm().map(|d| d.entry_count()), Some(1));
        // Second install is ignored — the already-armed entry survives.
        state.install_alarm_no_spawn(Arc::new(RecordingEmitter::default()));
        assert_eq!(state.alarm().map(|d| d.entry_count()), Some(1));
    }

    #[test]
    fn test_task_id_generation() {
        let id1 = SystemTask::generate_id();
        let id2 = SystemTask::generate_id();
        assert!(id1.starts_with("cognia-task-"));
        assert!(id2.starts_with("cognia-task-"));
        assert_ne!(id1, id2);
    }

    #[test]
    fn test_risk_level_calculation() {
        let task = SystemTask {
            id: "test".to_string(),
            name: "Test".to_string(),
            description: None,
            trigger: SystemTaskTrigger::Interval { seconds: 60 },
            action: SystemTaskAction::RunCommand {
                // A bare command (not under a privileged system dir like /usr,
                // /etc, C:\Windows) — `is_privileged_path` returns false, so a
                // plain interval RunCommand is Low risk.
                command: "echo".to_string(),
                args: vec!["hello".to_string()],
                working_dir: None,
                env: std::collections::HashMap::new(),
            },
            run_level: RunLevel::User,
            status: SystemTaskStatus::Enabled,
            requires_admin: false,
            tags: vec![],
            created_at: None,
            updated_at: None,
            last_run_at: None,
            next_run_at: None,
            last_result: None,
            metadata_state: TaskMetadataState::Full,
        };

        assert_eq!(task.calculate_risk_level(), RiskLevel::Low);
    }

    #[test]
    fn test_admin_script_is_critical() {
        let task = SystemTask {
            id: "test".to_string(),
            name: "Test".to_string(),
            description: None,
            trigger: SystemTaskTrigger::OnBoot { delay_seconds: 0 },
            action: SystemTaskAction::ExecuteScript {
                language: "python".to_string(),
                code: "print('hello')".to_string(),
                working_dir: None,
                args: vec![],
                env: std::collections::HashMap::new(),
                timeout_secs: 300,
                memory_mb: 512,
                use_sandbox: false,
            },
            run_level: RunLevel::Administrator,
            status: SystemTaskStatus::Enabled,
            requires_admin: true,
            tags: vec![],
            created_at: None,
            updated_at: None,
            last_run_at: None,
            next_run_at: None,
            last_result: None,
            metadata_state: TaskMetadataState::Full,
        };

        assert_eq!(task.calculate_risk_level(), RiskLevel::Critical);
    }

    #[tokio::test]
    async fn pending_confirmation_create_confirm_flow_executes_operation() {
        let state = build_state_with_mock();
        let input = risky_script_input("pending-create");

        let create_result = state
            .create_task_with_confirmation(input, false)
            .await
            .expect("create");
        let confirmation = create_result.expect_err("should require confirmation");

        let pending = state.get_pending_confirmations().await;
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].confirmation_id, confirmation.confirmation_id);

        let confirmed = state
            .confirm_task(&confirmation.confirmation_id)
            .await
            .expect("confirm");
        assert!(confirmed.is_some());

        let pending_after = state.get_pending_confirmations().await;
        assert!(pending_after.is_empty());
    }

    #[tokio::test]
    async fn pending_confirmation_update_cancel_flow_clears_record() {
        let state = build_state_with_mock();
        let created = state
            .create_task_with_confirmation(interval_command_input("seed"), true)
            .await
            .expect("seed create")
            .expect("no confirmation for low risk");

        let update_result = state
            .update_task(&created.id, risky_script_input("updated"), false)
            .await
            .expect("update");
        let confirmation = update_result.expect_err("update should require confirmation");

        let cancelled = state
            .cancel_confirmation(&confirmation.confirmation_id)
            .await;
        assert!(cancelled);

        let confirmed = state
            .confirm_task(&confirmation.confirmation_id)
            .await
            .expect("confirm after cancel");
        assert!(confirmed.is_none());
    }
}
