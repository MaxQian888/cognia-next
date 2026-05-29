//! cua desktop sandbox — remote Computer-Use execution target (ADR-0020
//! remote-target addendum). Phase 1 orchestrates a local Docker
//! `ghcr.io/trycua/cua-xfce` container and drives its `computer-server` over a
//! WebSocket, slotting in behind the existing automation gate as a `Remote`
//! `CallTarget`.

pub mod protocol;
