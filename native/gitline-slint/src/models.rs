// Slint models over the core's display data. They build each row only when the ListView asks for it,
// so a 5,000-commit history or a 20,000-line diff costs nothing until it scrolls into view.
use std::fmt::Write;
use std::sync::Arc;

use gitline_core::format::{format_date, relative_time, split_path};
use gitline_core::highlight::Style;
use gitline_core::view::{DiffView, History, NodeKind, RowKind};
use gitline_core::{FileChange, FileStatus, RefType, WIP};
use slint::{Color, Model, ModelRc, ModelTracker, SharedString, VecModel};

use crate::{CommitRow, DiffRow, FileRow, GraphLine, Pill, Seg};

pub fn rgb(c: u32) -> Color {
    Color::from_rgb_u8((c >> 16) as u8, (c >> 8) as u8, c as u8)
}

/// The default text colour (Theme.text), for spans without a syntax colour.
const TEXT: u32 = 0xdfe3e7;

/// SVG path data for a polyline. Slint's Path has no dash pattern, so dashed lines are cut into
/// 3px dashes here.
fn path_commands(points: &[(f32, f32)], dashed: bool) -> SharedString {
    let mut s = String::new();
    if !dashed {
        for (i, (x, y)) in points.iter().enumerate() {
            let _ = write!(s, "{}{x} {y} ", if i == 0 { "M" } else { "L" });
        }
        return s.into();
    }
    const ON: f32 = 3.0;
    const OFF: f32 = 3.0;
    let mut drawn = 0.0f32; // position within the current dash+gap cycle
    for w in points.windows(2) {
        let ((x1, y1), (x2, y2)) = (w[0], w[1]);
        let len = ((x2 - x1).powi(2) + (y2 - y1).powi(2)).sqrt();
        let mut t = 0.0;
        while t < len {
            let in_dash = drawn < ON;
            let step = (if in_dash { ON - drawn } else { ON + OFF - drawn }).min(len - t);
            if in_dash {
                let at = |d: f32| (x1 + (x2 - x1) * d / len, y1 + (y2 - y1) * d / len);
                let (a, b) = (at(t), at(t + step));
                let _ = write!(s, "M{} {} L{} {} ", a.0, a.1, b.0, b.1);
            }
            t += step;
            drawn = (drawn + step) % (ON + OFF);
        }
    }
    s.into()
}

pub struct HistoryModel {
    pub history: Arc<History>,
    pub head: Option<String>,
    pub detached: bool,
    pub now: i64,
}

impl Model for HistoryModel {
    type Data = CommitRow;

    fn row_count(&self) -> usize {
        self.history.commits.len()
    }

    fn row_data(&self, i: usize) -> Option<CommitRow> {
        let c = self.history.commits.get(i)?;
        let head = self.head.as_deref();
        let cell = self.history.cell(i, head);
        let lines: Vec<GraphLine> =
            cell.lines.iter().map(|l| GraphLine { commands: path_commands(&l.points, l.dashed), color: rgb(l.color) }).collect();
        let pills: Vec<Pill> = self
            .history
            .pills(i, head, self.detached)
            .into_iter()
            .map(|p| Pill {
                label: p.label.into(),
                kind: match p.kind {
                    RefType::Local => 0,
                    RefType::Remote => 1,
                    RefType::Tag => 2,
                },
                head: p.is_head,
                on_remote: p.on_remote,
            })
            .collect();
        let wip = c.sha == WIP;
        Some(CommitRow {
            sha: c.sha.as_str().into(),
            short: c.sha.get(..7).unwrap_or(&c.sha).into(),
            subject: c.subject.as_str().into(),
            author: c.author.as_str().into(),
            date: if wip { SharedString::new() } else { relative_time(c.time, self.now).into() },
            wip,
            lines: ModelRc::new(VecModel::from(lines)),
            node_x: cell.node_x,
            node_color: rgb(cell.node_color),
            node: match cell.node {
                NodeKind::Commit => 0,
                NodeKind::Merge => 1,
                NodeKind::Head => 2,
                NodeKind::Wip => 3,
            },
            pills: ModelRc::new(VecModel::from(pills)),
        })
    }

    fn model_tracker(&self) -> &dyn ModelTracker {
        // Replaced wholesale on every reload, so there are no row changes to report.
        &()
    }
}

pub struct DiffModel {
    pub view: Arc<DiffView>,
}

fn seg(text: &str, style: Style, changed: bool) -> Seg {
    Seg { text: text.into(), color: rgb(style.color.unwrap_or(TEXT)), italic: style.italic, changed }
}

impl Model for DiffModel {
    type Data = DiffRow;

    fn row_count(&self) -> usize {
        self.view.rows.len()
    }

    fn row_data(&self, i: usize) -> Option<DiffRow> {
        let r = self.view.rows.get(i)?;
        let segs: Vec<Seg> = r.spans.iter().map(|s| seg(&s.text, s.style, s.changed)).collect();
        let no = |n: Option<u32>| n.map_or_else(SharedString::new, |n| n.to_string().into());
        Some(DiffRow {
            kind: match r.kind {
                RowKind::Hunk => 0,
                RowKind::Add => 1,
                RowKind::Del => 2,
                RowKind::Ctx => 3,
                RowKind::Meta => 4,
            },
            hunk: r.hunk as i32,
            old_no: no(r.old_no),
            new_no: no(r.new_no),
            text: r.text.as_str().into(),
            segs: ModelRc::new(VecModel::from(segs)),
        })
    }

    fn model_tracker(&self) -> &dyn ModelTracker {
        &()
    }
}

pub fn status_color(s: FileStatus) -> u32 {
    match s {
        FileStatus::Added | FileStatus::Untracked => 0x4cc38a,
        FileStatus::Deleted => 0xef6f6c,
        FileStatus::Renamed | FileStatus::Copied => 0x4f8cff,
        FileStatus::Conflicted => 0xf4a259,
        FileStatus::Modified | FileStatus::TypeChanged => 0xe3b341,
    }
}

pub fn file_rows(files: &[FileChange]) -> ModelRc<FileRow> {
    let rows: Vec<FileRow> = files
        .iter()
        .map(|f| {
            let (dir, name) = split_path(&f.path);
            FileRow {
                path: f.path.as_str().into(),
                dir: dir.trim_end_matches('/').into(),
                name: name.into(),
                status: f.status.as_char().to_string().into(),
                color: rgb(status_color(f.status)),
            }
        })
        .collect();
    ModelRc::new(VecModel::from(rows))
}

pub fn commit_meta(author: &str, email: &str, time: i64, sha: &str) -> String {
    format!("{author} <{email}>\n{} · {}", format_date(time), sha.get(..10).unwrap_or(sha))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_svg_paths() {
        assert_eq!(path_commands(&[(1.0, 2.0), (3.0, 4.5)], false), "M1 2 L3 4.5 ");
    }

    #[test]
    fn cuts_dashed_lines_into_dashes() {
        let s = path_commands(&[(0.0, 0.0), (0.0, 12.0)], true);
        assert_eq!(s, "M0 0 L0 3 M0 6 L0 9 ");
    }
}
