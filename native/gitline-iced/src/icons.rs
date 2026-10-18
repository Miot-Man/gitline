// Lucide icons (the set the Electron app uses, ISC licence), as SVGs drawn in a given colour.
use iced::widget::{Svg, svg};
use iced::{Color, Length};

#[derive(Clone, Copy)]
pub struct Icon(&'static [u8]);

impl Icon {
    pub const ARCHIVE: Icon = Icon(include_bytes!("../../assets/icons/archive.svg"));
    pub const ARCHIVE_RESTORE: Icon = Icon(include_bytes!("../../assets/icons/archive-restore.svg"));
    pub const ARROW_DOWN: Icon = Icon(include_bytes!("../../assets/icons/arrow-down.svg"));
    pub const ARROW_RIGHT: Icon = Icon(include_bytes!("../../assets/icons/arrow-right.svg"));
    pub const ARROW_UP: Icon = Icon(include_bytes!("../../assets/icons/arrow-up.svg"));
    pub const CHECK: Icon = Icon(include_bytes!("../../assets/icons/check.svg"));
    pub const CHEVRON_DOWN: Icon = Icon(include_bytes!("../../assets/icons/chevron-down.svg"));
    pub const CHEVRON_LEFT: Icon = Icon(include_bytes!("../../assets/icons/chevron-left.svg"));
    pub const CHEVRON_RIGHT: Icon = Icon(include_bytes!("../../assets/icons/chevron-right.svg"));
    pub const CIRCLE_CHECK: Icon = Icon(include_bytes!("../../assets/icons/circle-check.svg"));
    pub const CLOUD: Icon = Icon(include_bytes!("../../assets/icons/cloud.svg"));
    pub const CODE_XML: Icon = Icon(include_bytes!("../../assets/icons/code-xml.svg"));
    pub const COLUMNS_2: Icon = Icon(include_bytes!("../../assets/icons/columns-2.svg"));
    pub const COPY: Icon = Icon(include_bytes!("../../assets/icons/copy.svg"));
    pub const EYE_OFF: Icon = Icon(include_bytes!("../../assets/icons/eye-off.svg"));
    pub const FILE_DIFF: Icon = Icon(include_bytes!("../../assets/icons/file-diff.svg"));
    pub const FOLDER: Icon = Icon(include_bytes!("../../assets/icons/folder.svg"));
    pub const FOLDER_OPEN: Icon = Icon(include_bytes!("../../assets/icons/folder-open.svg"));
    pub const GIT_BRANCH: Icon = Icon(include_bytes!("../../assets/icons/git-branch.svg"));
    pub const GIT_COMMIT_HORIZONTAL: Icon = Icon(include_bytes!("../../assets/icons/git-commit-horizontal.svg"));
    pub const GIT_PULL_REQUEST: Icon = Icon(include_bytes!("../../assets/icons/git-pull-request.svg"));
    pub const INFO: Icon = Icon(include_bytes!("../../assets/icons/info.svg"));
    pub const MINUS: Icon = Icon(include_bytes!("../../assets/icons/minus.svg"));
    pub const PENCIL: Icon = Icon(include_bytes!("../../assets/icons/pencil.svg"));
    pub const PLUS: Icon = Icon(include_bytes!("../../assets/icons/plus.svg"));
    pub const REDO_2: Icon = Icon(include_bytes!("../../assets/icons/redo-2.svg"));
    pub const REFRESH_CW: Icon = Icon(include_bytes!("../../assets/icons/refresh-cw.svg"));
    pub const ROWS_3: Icon = Icon(include_bytes!("../../assets/icons/rows-3.svg"));
    pub const SEARCH: Icon = Icon(include_bytes!("../../assets/icons/search.svg"));
    pub const SETTINGS: Icon = Icon(include_bytes!("../../assets/icons/settings.svg"));
    pub const SQUARE_TERMINAL: Icon = Icon(include_bytes!("../../assets/icons/square-terminal.svg"));
    pub const TAG: Icon = Icon(include_bytes!("../../assets/icons/tag.svg"));
    pub const TRASH: Icon = Icon(include_bytes!("../../assets/icons/trash.svg"));
    pub const TRIANGLE_ALERT: Icon = Icon(include_bytes!("../../assets/icons/triangle-alert.svg"));
    pub const UNDO_2: Icon = Icon(include_bytes!("../../assets/icons/undo-2.svg"));
    pub const USERS: Icon = Icon(include_bytes!("../../assets/icons/users.svg"));
    pub const WAYPOINTS: Icon = Icon(include_bytes!("../../assets/icons/waypoints.svg"));
    pub const X: Icon = Icon(include_bytes!("../../assets/icons/x.svg"));

    /// The icon at `size` px, in `color`.
    pub fn view(self, size: f32, color: Color) -> Svg<'static> {
        svg(svg::Handle::from_memory(self.0))
            .width(Length::Fixed(size))
            .height(Length::Fixed(size))
            .style(move |_, _| svg::Style { color: Some(color) })
    }
}
