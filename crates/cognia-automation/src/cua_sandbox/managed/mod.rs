//! Host-owned managed desktops (ADR-0228 P1/P2). GUI control stays dormant
//! until separately qualified; agent input and acceptance handoff remain dormant.
pub mod contracts;
pub mod evidence;
pub mod handoff;
pub mod journal;
pub mod provider;
pub mod service;

pub use contracts::*;
pub use provider::{
    E2bDesktopProvider, FileManagedDesktopSecrets, ManagedDesktopImageVerifier,
    ManagedDesktopProvider, ManagedDesktopSecrets,
};
pub use service::{
    run_qualification_smoke, ExplicitPaidSmokeAuthorization, ManagedDesktopService,
    ManagedDesktopSmokeHost,
};

pub use service::control::{
    run_control_qualification_smoke, ControlQualificationReceipt, ManagedControlAuthority,
    ManagedControlFrame, ManagedControlLease, ManagedControlStatus,
};
