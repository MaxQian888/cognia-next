//! Separate per-device capability gate for macOS Locked Use.

use std::collections::HashSet;
use std::sync::Arc;

use once_cell::sync::Lazy;
use parking_lot::RwLock;

static LOCKED_USE_ALLOW_LIST: Lazy<Arc<LockedUseAllowList>> =
    Lazy::new(|| Arc::new(LockedUseAllowList::default()));

pub fn global() -> &'static Arc<LockedUseAllowList> {
    &LOCKED_USE_ALLOW_LIST
}

#[derive(Default)]
pub struct LockedUseAllowList {
    inner: RwLock<HashSet<String>>,
}

impl LockedUseAllowList {
    pub fn allow(&self, device_id: String) -> bool {
        self.inner.write().insert(device_id)
    }

    pub fn disallow(&self, device_id: &str) -> bool {
        self.inner.write().remove(device_id)
    }

    pub fn is_allowed(&self, device_id: &str) -> bool {
        self.inner.read().contains(device_id)
    }

    pub fn reseed(&self, device_ids: Vec<String>) {
        *self.inner.write() = device_ids.into_iter().collect();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_deny_and_reseed_replaces() {
        let list = LockedUseAllowList::default();
        assert!(!list.is_allowed("device"));
        list.allow("stale".into());
        list.reseed(vec!["fresh".into()]);
        assert!(!list.is_allowed("stale"));
        assert!(list.is_allowed("fresh"));
        assert!(list.disallow("fresh"));
        assert!(!list.is_allowed("fresh"));
    }
}
