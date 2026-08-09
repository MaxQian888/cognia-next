//! Bridges between the recorder's trait seams and the subsystems that own the
//! answers.
//!
//! `cognia-automation` deliberately depends on neither `cognia-plugin-runtime`
//! nor `cognia-ocr` — both edges would invert the layering (the plugin runtime
//! and the OCR crate are consumers of automation, not the other way round). So
//! the recorder declares traits and `src-tauri`, which already holds all three,
//! wires them at boot.

use std::collections::HashMap;
use std::sync::Arc;

use cognia_automation::automation::record::ocr_fallback::RegionOcr;
use cognia_automation::automation::record::plugin_facts::{PluginFacts, PluginFactsSource};
use cognia_ocr::native::{NativeOcrInvokePayload, NativeOcrRegistry};
use cognia_plugin_runtime::{PermissionGrant, PluginRecord, PluginRuntimeState};

/// The only OCR backends a recording may use.
///
/// Hard-coded rather than derived from the registry: OCR here reads whatever the
/// user happened to be looking at, and routing that to a network provider is not
/// a fallback, it is a different product. Restricting the id at the dispatch
/// point means a future cloud backend cannot be selected by accident.
const LOCAL_BACKENDS: [&str; 2] = ["apple-vision", "windows-media-ocr"];

/// Reads the live plugin registry so preflight can report whether the recorder's
/// owning plugin is installed, enabled, and holds its three manifest grants.
pub struct RuntimePluginFacts {
    /// The two shared maps, cloned out of the managed state. `PluginRuntimeState`
    /// itself is not `Clone` and holds a good deal more; these are the only parts
    /// a preflight needs, and taking just them keeps the borrow off the managed
    /// value entirely.
    plugins: Arc<parking_lot::RwLock<HashMap<String, PluginRecord>>>,
    permissions: Arc<parking_lot::RwLock<HashMap<String, Vec<PermissionGrant>>>>,
}

impl RuntimePluginFacts {
    pub fn new(state: &PluginRuntimeState) -> Self {
        Self {
            plugins: state.plugins.clone(),
            permissions: state.permissions.clone(),
        }
    }
}

impl PluginFactsSource for RuntimePluginFacts {
    fn facts(&self, plugin_id: &str) -> PluginFacts {
        let plugins = self.plugins.read();
        let Some(record) = plugins.get(plugin_id) else {
            return PluginFacts::default();
        };
        // `status` is the runtime's own vocabulary; anything other than an
        // active plugin reads as disabled, which fails the preflight closed.
        let enabled = record.snapshot.status.eq_ignore_ascii_case("enabled")
            || record.snapshot.status.eq_ignore_ascii_case("active")
            || record.snapshot.status.eq_ignore_ascii_case("loaded");
        drop(plugins);

        let granted = self
            .permissions
            .read()
            .get(plugin_id)
            .map(|grants| grants.iter().map(|g| g.permission.clone()).collect())
            .unwrap_or_default();

        PluginFacts {
            installed: true,
            enabled,
            granted,
        }
    }
}

/// Routes the recorder's OCR fallback to an on-device backend, or reports that
/// there isn't one.
pub struct LocalRegionOcr {
    registry: NativeOcrRegistry,
    /// Resolved once at boot. The set of installed backends does not change
    /// within a session, and probing it is `async` while `available()` is not.
    backends: Vec<String>,
}

impl LocalRegionOcr {
    /// `available_ids` already excludes placeholder backends, which is why
    /// Windows correctly reports nothing today: `windows-media-ocr` is still a
    /// `PlaceholderBackend`. Reporting that honestly is right — the review UI
    /// asks the user to annotate those steps instead.
    pub async fn resolve(registry: NativeOcrRegistry) -> Self {
        let backends = registry
            .available_ids()
            .await
            .into_iter()
            .filter(|id| LOCAL_BACKENDS.contains(id))
            .map(|id| id.to_string())
            .collect();
        Self { registry, backends }
    }
}

#[async_trait::async_trait]
impl RegionOcr for LocalRegionOcr {
    fn available(&self) -> bool {
        !self.backends.is_empty()
    }

    fn backend_ids(&self) -> Vec<String> {
        self.backends.clone()
    }

    async fn extract(&self, image_base64: String) -> Option<String> {
        use base64::engine::general_purpose;
        use base64::Engine as _;

        let backend = self.backends.first()?.clone();
        debug_assert!(
            LOCAL_BACKENDS.contains(&backend.as_str()),
            "only on-device OCR backends may be dispatched from the recorder"
        );
        let bytes = general_purpose::STANDARD
            .decode(image_base64.as_bytes())
            .ok()?;
        let result = self
            .registry
            .dispatch(&NativeOcrInvokePayload {
                backend,
                bytes,
                mime_type: "image/png".into(),
                languages: Vec::new(),
                model_variant: None,
            })
            .await
            .ok()?;
        let text = result.text.trim().to_string();
        (!text.is_empty()).then_some(text)
    }
}

/// Shows and hides the controller strip on behalf of the recording session.
///
/// Owns a concrete `AppHandle` so the session — which is generic-free and lives
/// in another crate — can drive the window on every teardown path, including the
/// ones the renderer never sees (limit breach, scope loss, kill switch, quit).
struct ControllerSurface<R: tauri::Runtime> {
    app: tauri::AppHandle<R>,
}

impl<R: tauri::Runtime> cognia_automation::automation::record::session::RecorderSurface
    for ControllerSurface<R>
{
    fn show(&self) {
        if let Err(error) = super::show(&self.app) {
            // Loud but not fatal: a recording without its strip is still a
            // recording, and the Sheet can still stop it. Failing the capture
            // here would be the worse trade.
            log::error!("skill recorder: controller strip failed to open: {error}");
        }
    }

    fn hide(&self) {
        super::destroy(&self.app);
    }
}

/// Convenience for boot: build every seam and hand them to the recorder.
pub async fn register<R: tauri::Runtime>(app: &tauri::AppHandle<R>)
where
    R: 'static,
{
    use cognia_automation::automation::commands::AutomationState;
    use cognia_automation::automation::record::secure_input::PlatformSecureProbe;
    use tauri::Manager;

    let automation = app.state::<AutomationState>();
    automation
        .recorder
        .set_surface(Arc::new(ControllerSurface { app: app.clone() }));
    if let Some(plugins) = app.try_state::<PluginRuntimeState>() {
        automation
            .recorder
            .set_plugin_facts(Arc::new(RuntimePluginFacts::new(plugins.inner())));
    } else {
        log::warn!(
            "skill recorder: plugin runtime state unavailable; preflight will report the \
             recorder plugin as not installed"
        );
    }
    if let Some(ocr) = app.try_state::<NativeOcrRegistry>() {
        automation
            .recorder
            .set_region_ocr(Arc::new(LocalRegionOcr::resolve(ocr.inner().clone()).await));
    }
    automation
        .recorder
        .set_secure_probe(Arc::new(PlatformSecureProbe));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_backends_are_on_device_only() {
        // The whole point of the allow-list. A cloud id appearing here would let
        // a recording's screen content leave the machine without the user ever
        // choosing that.
        assert_eq!(LOCAL_BACKENDS, ["apple-vision", "windows-media-ocr"]);
        for id in LOCAL_BACKENDS {
            assert!(!id.contains("cloud"));
            assert!(!id.contains("api"));
        }
    }

    #[test]
    fn missing_plugin_record_fails_closed() {
        // No record for the plugin means "not installed", which the admission
        // check reads as a blocker. Fails closed rather than assuming grants
        // nobody checked.
        let facts = RuntimePluginFacts {
            plugins: Arc::new(parking_lot::RwLock::new(HashMap::new())),
            permissions: Arc::new(parking_lot::RwLock::new(HashMap::new())),
        }
        .facts("cognia-skill-recorder");
        assert!(!facts.installed);
        assert!(!facts.enabled);
        assert!(facts.granted.is_empty());
    }

    #[test]
    fn a_disabled_plugin_reports_installed_but_not_enabled() {
        let mut plugins = HashMap::new();
        plugins.insert(
            "cognia-skill-recorder".to_string(),
            PluginRecord {
                snapshot: cognia_plugin_runtime::PluginRuntimeSnapshot {
                    plugin_id: "cognia-skill-recorder".into(),
                    version: "0.1.0".into(),
                    status: "disabled".into(),
                    last_error: None,
                    loaded_at: None,
                    install_path: String::new(),
                },
                runtime_state: serde_json::Value::Null,
            },
        );
        let mut permissions = HashMap::new();
        permissions.insert(
            "cognia-skill-recorder".to_string(),
            vec![PermissionGrant {
                plugin_id: "cognia-skill-recorder".into(),
                permission: "native:input".into(),
                granted_by: "user".into(),
                granted_at: String::new(),
                expires_at: None,
            }],
        );

        let facts = RuntimePluginFacts {
            plugins: Arc::new(parking_lot::RwLock::new(plugins)),
            permissions: Arc::new(parking_lot::RwLock::new(permissions)),
        }
        .facts("cognia-skill-recorder");
        assert!(facts.installed);
        assert!(
            !facts.enabled,
            "a disabled plugin must not admit a recording"
        );
        assert_eq!(facts.granted, vec!["native:input"]);
    }
}
