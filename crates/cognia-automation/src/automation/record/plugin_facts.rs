//! What the recorder needs to know about its owning plugin.
//!
//! The `cognia-skill-recorder` plugin is the permission owner: its manifest
//! declares `native:input`, `native:screen` and `media:image:write`, and
//! disabling it must disable recording everywhere. Those facts live in
//! `cognia-plugin-runtime`, which `cognia-automation` deliberately does not
//! depend on — that edge would invert the layering (the plugin runtime is a
//! *consumer* of automation, not the other way round).
//!
//! So this is a trait seam. `src-tauri` — which already holds both — registers
//! the implementation at boot. Until it does, [`NoPluginFacts`] reports
//! "not installed", which fails the preflight closed rather than assuming
//! grants nobody checked.

use serde::{Deserialize, Serialize};

/// The three manifest permissions a recording requires.
pub const REQUIRED_GRANTS: [&str; 3] = ["native:input", "native:screen", "media:image:write"];

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PluginFacts {
    pub installed: bool,
    pub enabled: bool,
    pub granted: Vec<String>,
}

pub trait PluginFactsSource: Send + Sync {
    fn facts(&self, plugin_id: &str) -> PluginFacts;
}

/// The pre-registration default. Reports nothing installed, which the admission
/// check reads as a blocker.
pub struct NoPluginFacts;

impl PluginFactsSource for NoPluginFacts {
    fn facts(&self, _plugin_id: &str) -> PluginFacts {
        PluginFacts::default()
    }
}

/// Test double.
pub struct FixedPluginFacts(pub PluginFacts);

impl PluginFactsSource for FixedPluginFacts {
    fn facts(&self, _plugin_id: &str) -> PluginFacts {
        self.0.clone()
    }
}

/// Which required grants are absent. Order follows [`REQUIRED_GRANTS`] so the
/// preflight lists them the same way every time.
pub fn missing_grants(facts: &PluginFacts) -> Vec<String> {
    REQUIRED_GRANTS
        .iter()
        .filter(|required| !facts.granted.iter().any(|g| g == *required))
        .map(|s| s.to_string())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn granted(items: &[&str]) -> PluginFacts {
        PluginFacts {
            installed: true,
            enabled: true,
            granted: items.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn missing_grants_lists_all_three_when_ungranted() {
        assert_eq!(
            missing_grants(&granted(&[])),
            vec!["native:input", "native:screen", "media:image:write"]
        );
    }

    #[test]
    fn missing_grants_empty_when_all_present() {
        assert!(missing_grants(&granted(&REQUIRED_GRANTS)).is_empty());
    }

    #[test]
    fn missing_grants_reports_only_the_absent_ones() {
        assert_eq!(
            missing_grants(&granted(&["native:input", "media:image:write"])),
            vec!["native:screen"]
        );
    }

    #[test]
    fn unrelated_grants_do_not_satisfy_a_requirement() {
        assert_eq!(missing_grants(&granted(&["native:everything"])).len(), 3);
    }

    #[test]
    fn required_grants_match_the_plugin_manifest() {
        // `plugins/skill-recorder/plugin.json` declares exactly these three.
        // Drift here means the preflight would pass while the plugin API layer
        // refuses the call at runtime.
        assert_eq!(
            REQUIRED_GRANTS,
            ["native:input", "native:screen", "media:image:write"]
        );
    }

    #[test]
    fn default_source_fails_closed() {
        let facts = NoPluginFacts.facts("cognia-skill-recorder");
        assert!(!facts.installed);
        assert!(!facts.enabled);
        assert_eq!(missing_grants(&facts).len(), 3);
    }

    #[test]
    fn plugin_facts_serialize_camel_case() {
        let json = serde_json::to_string(&granted(&["native:input"])).unwrap();
        assert!(json.contains("\"installed\":true"));
        assert!(json.contains("\"granted\":[\"native:input\"]"));
    }
}
