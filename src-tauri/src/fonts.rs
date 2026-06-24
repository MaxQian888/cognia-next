//! System font enumeration for the appearance / terminal font pickers.
//!
//! The webview can't probe installed fonts (WKWebView on macOS has no Local
//! Font Access API, and Tauri's webview isn't granted it elsewhere), so the
//! renderer asks Rust. `fontdb` loads the OS font set and reports each
//! face's monospaced flag, which the terminal picker uses to show only
//! fixed-pitch families. Results feed `lib/appearance/font-registry.ts` via
//! `setSystemFonts` at desktop boot.

use std::collections::BTreeMap;

use serde::Serialize;

/// One installed font family, with whether it is fixed-pitch.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SystemFont {
    pub family: String,
    pub monospaced: bool,
}

/// Collapse raw `(family, monospaced)` faces into one entry per family,
/// sorted by family name. A family counts as monospaced if *any* of its
/// faces is — some families ship a fixed-pitch regular face but mislabel the
/// italic/bold metadata, and a font the user thinks of as monospace should
/// survive the terminal picker's filter. Blank names are dropped. Pure, so
/// it's unit-tested without touching the real font database.
fn dedupe_families<I>(faces: I) -> Vec<SystemFont>
where
    I: IntoIterator<Item = (String, bool)>,
{
    let mut map: BTreeMap<String, bool> = BTreeMap::new();
    for (family, monospaced) in faces {
        let name = family.trim().to_string();
        if name.is_empty() {
            continue;
        }
        let entry = map.entry(name).or_insert(false);
        *entry = *entry || monospaced;
    }
    map.into_iter()
        .map(|(family, monospaced)| SystemFont { family, monospaced })
        .collect()
}

/// Enumerate installed font families with a monospaced flag. Sorted by
/// family name, one entry per family.
#[tauri::command]
pub fn os_list_fonts() -> Vec<SystemFont> {
    let mut db = fontdb::Database::new();
    db.load_system_fonts();
    let faces = db.faces().filter_map(|face| {
        let family = face.families.first().map(|(name, _)| name.clone())?;
        Some((family, face.monospaced))
    });
    dedupe_families(faces)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dedupe_merges_faces_or_reduces_monospaced_and_sorts() {
        let out = dedupe_families([
            ("JetBrains Mono".to_string(), true),
            ("JetBrains Mono".to_string(), false), // italic face mislabeled
            ("Arial".to_string(), false),
            ("  ".to_string(), true), // blank dropped
            ("Menlo".to_string(), true),
        ]);
        assert_eq!(
            out,
            vec![
                SystemFont {
                    family: "Arial".into(),
                    monospaced: false
                },
                SystemFont {
                    family: "JetBrains Mono".into(),
                    monospaced: true
                },
                SystemFont {
                    family: "Menlo".into(),
                    monospaced: true
                },
            ]
        );
    }

    #[test]
    fn dedupe_trims_and_drops_blank_only_families() {
        let out = dedupe_families([("  Fira Code  ".to_string(), true), ("".to_string(), false)]);
        assert_eq!(
            out,
            vec![SystemFont {
                family: "Fira Code".into(),
                monospaced: true
            }]
        );
    }
}
