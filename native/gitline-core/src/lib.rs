//! Gitline's git layer and the pure logic behind its screens, shared by the native front ends.
//!
//! `git` runs the `git` CLI exactly as `electron/git.cjs` does; `graph`, `diff`, `word_diff` and
//! `highlight` are ports of `src/lib/`; `view` turns their output into rows a UI can draw.
pub mod diff;
pub mod git;
pub mod graph;
pub mod highlight;
pub mod types;
pub mod view;
pub mod word_diff;

pub use git::{Error, Repo, Result};
pub use types::*;
