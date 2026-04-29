// Runtime window-behavior toggles pushed from the frontend.
//
// Currently just one flag — `tray_on_close` — controlling whether closing the
// main window should hide it (keeping the app alive in the system tray) or
// actually close. The frontend persists the user's choice via the store
// plugin and pushes the value into us through `set_tray_on_close` on toggle
// and at boot. The close-requested handler installed in `lib.rs` reads this
// flag synchronously, so an `AtomicBool` is enough.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

#[derive(Clone, Default)]
pub struct WindowBehavior {
    tray_on_close: Arc<AtomicBool>,
}

impl WindowBehavior {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_tray_on_close(&self, enabled: bool) {
        self.tray_on_close.store(enabled, Ordering::Relaxed);
    }

    pub fn tray_on_close(&self) -> bool {
        self.tray_on_close.load(Ordering::Relaxed)
    }
}

#[tauri::command]
pub fn set_tray_on_close(state: tauri::State<'_, WindowBehavior>, enabled: bool) {
    state.set_tray_on_close(enabled);
}

#[tauri::command]
pub fn get_tray_on_close(state: tauri::State<'_, WindowBehavior>) -> bool {
    state.tray_on_close()
}
