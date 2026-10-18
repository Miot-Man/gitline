// The Electron app's dark theme tokens (src/styles.css :root), fonts and widget styles. Class names
// in the comments are the CSS classes each style copies.
use iced::widget::{button, checkbox, container, pick_list, scrollable, text_editor, text_input};
use iced::{Background, Border, Color, Font, Shadow, Theme, Vector, font};

pub const fn hex(c: u32) -> Color {
    Color::from_rgb8((c >> 16) as u8, (c >> 8) as u8, c as u8)
}

pub const fn hexa(c: u32, a: f32) -> Color {
    Color::from_rgba8((c >> 16) as u8, (c >> 8) as u8, c as u8, a)
}

/// `c` at opacity `t` over `bg`, as a solid colour (for icons, which don't take a translucent tint).
pub fn mix(c: Color, bg: Color, t: f32) -> Color {
    Color::from_rgb(bg.r + (c.r - bg.r) * t, bg.g + (c.g - bg.g) * t, bg.b + (c.b - bg.b) * t)
}

/// `color-mix(in srgb, c p%, transparent)`
pub const fn alpha(c: Color, a: f32) -> Color {
    Color { a, ..c }
}

pub const BG: Color = hex(0x0e1114);
pub const BG_GRAPH: Color = hex(0x13171b);
pub const BG_PANEL: Color = hex(0x161a1f);
pub const BG_PANEL_2: Color = hex(0x1c2127);
pub const BG_TOOLBAR: Color = hex(0x161a1f);
pub const BG_TABBAR: Color = hex(0x0b0d10);
pub const BG_HOVER: Color = hex(0x20262d);
pub const BG_ACTIVE: Color = hex(0x1d3836);
pub const BG_INPUT: Color = hex(0x0f1215);
pub const BG_MENU: Color = hex(0x1c2127);
pub const BORDER: Color = hex(0x2a3138);
pub const BORDER_SOFT: Color = hex(0x20262c);
pub const BORDER_MENU: Color = hex(0x2f363e);
pub const DIVIDER: Color = hex(0x0a0c0e);
pub const TEXT: Color = hex(0xdfe3e7);
pub const TEXT_STRONG: Color = hex(0xf5f7f9);
pub const MUTED: Color = hex(0x8b949e);
pub const ACCENT: Color = hex(0x2ec4b6);
pub const ACCENT_STRONG: Color = hex(0x22a597);
pub const GREEN: Color = hex(0x4cc38a);
pub const GREEN_STRONG: Color = hex(0x3aa874);
pub const GREEN_TEXT: Color = hex(0x8be28f);
pub const RED: Color = hex(0xef6f6c);
pub const RED_TEXT: Color = hex(0xff8a8d);
pub const YELLOW: Color = hex(0xe3b341);
pub const BLUE: Color = hex(0x4f8cff);
pub const ORANGE: Color = hex(0xf4a259);
pub const SCROLLBAR: Color = hex(0x2f363e);
pub const SCROLLBAR_HOVER: Color = hex(0x3d454e);
pub const ROW_HOVER: Color = Color::from_rgba(1.0, 1.0, 1.0, 0.035);
pub const WHITE: Color = Color::WHITE;
pub const LN: Color = hex(0x5d6370);
pub const LN_BG: Color = Color::from_rgba(0.0, 0.0, 0.0, 0.12);
pub const ADD_BG: Color = hexa(0x3fb34f, 0.16);
pub const ADD_LN_BG: Color = hexa(0x3fb34f, 0.22);
pub const ADD_LN: Color = hex(0x7fbf86);
pub const ADD_SIGN: Color = hex(0x6fd37b);
pub const ADD_WORD: Color = hexa(0x3fb34f, 0.4);
pub const DEL_BG: Color = hexa(0xe5484d, 0.16);
pub const DEL_LN_BG: Color = hexa(0xe5484d, 0.22);
pub const DEL_LN: Color = hex(0xc98385);
pub const DEL_SIGN: Color = hex(0xff7b80);
pub const DEL_WORD: Color = hexa(0xe5484d, 0.4);
pub const SELECTION: Color = hexa(0x2ec4b6, 0.35);

pub const SANS: Font = Font::with_name("IBM Plex Sans");
pub const SANS_MEDIUM: Font = Font { weight: font::Weight::Medium, ..SANS };
pub const SANS_BOLD: Font = Font { weight: font::Weight::Semibold, ..SANS };
pub const SANS_ITALIC: Font = Font { style: font::Style::Italic, ..SANS };
pub const MONO: Font = Font::with_name("JetBrains Mono");
pub const MONO_ITALIC: Font = Font { style: font::Style::Italic, ..MONO };

pub const FONTS: [&[u8]; 6] = [
    include_bytes!("../../assets/fonts/IBMPlexSans-Regular.ttf"),
    include_bytes!("../../assets/fonts/IBMPlexSans-Medium.ttf"),
    include_bytes!("../../assets/fonts/IBMPlexSans-SemiBold.ttf"),
    include_bytes!("../../assets/fonts/IBMPlexSans-Italic.ttf"),
    include_bytes!("../../assets/fonts/JetBrainsMono-Regular.ttf"),
    include_bytes!("../../assets/fonts/JetBrainsMono-Italic.ttf"),
];

/// The app's fonts (embedded), default font and the Electron app's 13px text size.
pub fn settings() -> iced::Settings {
    iced::Settings {
        fonts: FONTS.iter().map(|f| std::borrow::Cow::Borrowed(*f)).collect(),
        default_font: SANS,
        default_text_size: iced::Pixels(13.0),
        antialiasing: true,
        ..Default::default()
    }
}

pub fn theme() -> Theme {
    Theme::custom(
        "Gitline",
        iced::theme::Palette { background: BG, text: TEXT, primary: ACCENT, success: GREEN, warning: YELLOW, danger: RED },
    )
}

pub const SQUARE: iced::border::Radius = iced::border::Radius { top_left: 2.0, top_right: 2.0, bottom_right: 2.0, bottom_left: 2.0 };

pub fn border(color: Color) -> Border {
    Border { color, width: 1.0, radius: SQUARE }
}

pub fn fill(color: Color) -> impl Fn(&Theme) -> container::Style {
    move |_| container::Style { background: Some(Background::Color(color)), ..Default::default() }
}

/// A box with a background and a 1px border.
pub fn boxed(bg: Color, line: Color) -> impl Fn(&Theme) -> container::Style {
    move |_| container::Style { background: Some(Background::Color(bg)), border: border(line), ..Default::default() }
}

fn btn(bg: Color, hover_bg: Color, line: Color, fg: Color) -> impl Fn(&Theme, button::Status) -> button::Style {
    move |_, status| {
        let (bg, fg) = match status {
            button::Status::Hovered | button::Status::Pressed => (hover_bg, fg),
            button::Status::Disabled => (alpha(bg, bg.a * 0.45), alpha(fg, 0.45)),
            button::Status::Active => (bg, fg),
        };
        button::Style { background: Some(Background::Color(bg)), text_color: fg, border: border(line), ..Default::default() }
    }
}

/// `.btn`
pub fn plain(t: &Theme, s: button::Status) -> button::Style {
    btn(BG_PANEL_2, BG_HOVER, BORDER, TEXT)(t, s)
}

/// `.btn-stage`
pub fn stage(t: &Theme, s: button::Status) -> button::Style {
    btn(GREEN, GREEN_STRONG, GREEN, WHITE)(t, s)
}

/// `.btn-unstage`
pub fn unstage(t: &Theme, s: button::Status) -> button::Style {
    btn(Color::TRANSPARENT, alpha(RED, 0.18), alpha(RED, 0.7), RED_TEXT)(t, s)
}

/// `.btn-danger-ghost`
pub fn danger_ghost(t: &Theme, s: button::Status) -> button::Style {
    btn(Color::TRANSPARENT, alpha(RED, 0.18), alpha(RED, 0.6), RED_TEXT)(t, s)
}

/// `.btn-commit`, and its disabled look.
pub fn commit(_: &Theme, s: button::Status) -> button::Style {
    let (bg, line, fg) = match s {
        button::Status::Disabled => (BG_HOVER, BORDER, MUTED),
        button::Status::Hovered | button::Status::Pressed => (GREEN_STRONG, GREEN, WHITE),
        button::Status::Active => (GREEN, GREEN, WHITE),
    };
    button::Style { background: Some(Background::Color(bg)), text_color: fg, border: border(line), ..Default::default() }
}

/// `.btn.ws-toggle`, with `.on`.
pub fn toggle(on: bool) -> impl Fn(&Theme, button::Status) -> button::Style {
    move |t, s| {
        let mut st = plain(t, s);
        if on {
            st.border = border(ACCENT);
            st.text_color = ACCENT;
        }
        st
    }
}

/// `.seg button`, with `.on`.
pub fn seg(on: bool) -> impl Fn(&Theme, button::Status) -> button::Style {
    move |_, _| button::Style {
        background: on.then_some(Background::Color(BG_ACTIVE)),
        text_color: if on { TEXT_STRONG } else { MUTED },
        border: Border::default(),
        ..Default::default()
    }
}

/// `.icon-btn`
pub fn icon_btn(_: &Theme, s: button::Status) -> button::Style {
    let hover = matches!(s, button::Status::Hovered | button::Status::Pressed);
    button::Style {
        background: hover.then_some(Background::Color(BG_HOVER)),
        text_color: if hover { TEXT_STRONG } else { MUTED },
        border: Border { radius: SQUARE, ..Border::default() },
        ..Default::default()
    }
}

/// `.tool-btn` inside a `.tool-group` (the group draws the border).
pub fn tool_btn(_: &Theme, s: button::Status) -> button::Style {
    let (bg, fg) = match s {
        button::Status::Hovered | button::Status::Pressed => (Some(Background::Color(BG_HOVER)), TEXT_STRONG),
        button::Status::Disabled => (None, alpha(TEXT, 0.4)),
        button::Status::Active => (None, TEXT),
    };
    button::Style { background: bg, text_color: fg, border: Border::default(), ..Default::default() }
}

/// `.split-caret`
pub fn caret(_: &Theme, s: button::Status) -> button::Style {
    let hover = matches!(s, button::Status::Hovered | button::Status::Pressed);
    button::Style {
        background: hover.then_some(Background::Color(BG_HOVER)),
        text_color: if hover { TEXT_STRONG } else { MUTED },
        ..Default::default()
    }
}

/// `.trail-back`
pub fn back(_: &Theme, s: button::Status) -> button::Style {
    let hover = matches!(s, button::Status::Hovered | button::Status::Pressed);
    button::Style {
        background: hover.then_some(Background::Color(BG_HOVER)),
        text_color: if hover { TEXT_STRONG } else { TEXT },
        border: border(BORDER),
        ..Default::default()
    }
}

/// Text-only buttons: `.trail-branch`, `.trail-link`, `.side-title-btn`, `.status-link`.
pub fn ghost(fg: Color, hover_fg: Color, hover_bg: bool) -> impl Fn(&Theme, button::Status) -> button::Style {
    move |_, s| {
        let hover = matches!(s, button::Status::Hovered | button::Status::Pressed);
        button::Style {
            background: (hover && hover_bg).then_some(Background::Color(BG_HOVER)),
            text_color: if hover { hover_fg } else { fg },
            border: Border { radius: SQUARE, ..Border::default() },
            ..Default::default()
        }
    }
}

/// `.rail-tile`, with `.active`.
pub fn rail_tile(active: bool) -> impl Fn(&Theme, button::Status) -> button::Style {
    move |_, s| {
        let hover = matches!(s, button::Status::Hovered | button::Status::Pressed);
        let (bg, line, fg) = if active {
            (alpha(ACCENT, 0.12), ACCENT, ACCENT)
        } else if hover {
            (BG_HOVER, BORDER, TEXT_STRONG)
        } else {
            (Color::TRANSPARENT, BORDER, MUTED)
        };
        button::Style { background: Some(Background::Color(bg)), text_color: fg, border: border(line), ..Default::default() }
    }
}

/// `.rail-btn`, with `.active`; the active one's inset accent bar is drawn by the caller.
pub fn rail_btn(active: bool) -> impl Fn(&Theme, button::Status) -> button::Style {
    move |_, s| {
        let hover = matches!(s, button::Status::Hovered | button::Status::Pressed);
        button::Style {
            background: (active || hover).then_some(Background::Color(if active { BG_PANEL_2 } else { BG_HOVER })),
            text_color: if active || hover { TEXT_STRONG } else { MUTED },
            border: Border { radius: SQUARE, ..Border::default() },
            ..Default::default()
        }
    }
}

/// A list row (`.file-row`, `.side-item`, `.graph-row`): a fixed background, or `hover` under the mouse.
pub fn row_btn(bg: Option<Color>, hover: Color) -> impl Fn(&Theme, button::Status) -> button::Style {
    move |_, s| {
        let hovered = matches!(s, button::Status::Hovered | button::Status::Pressed);
        button::Style {
            background: bg.or(hovered.then_some(hover)).map(Background::Color),
            text_color: TEXT,
            border: Border::default(),
            ..Default::default()
        }
    }
}

pub fn input(_: &Theme, status: text_input::Status) -> text_input::Style {
    text_input::Style {
        background: Background::Color(BG_INPUT),
        border: border(if matches!(status, text_input::Status::Focused { .. }) { ACCENT } else { BORDER }),
        icon: MUTED,
        placeholder: MUTED,
        value: TEXT,
        selection: SELECTION,
    }
}

/// An input inside its own bordered box (the sidebar filter, the summary with its counter).
pub fn bare_input(_: &Theme, _: text_input::Status) -> text_input::Style {
    text_input::Style {
        background: Background::Color(Color::TRANSPARENT),
        border: Border::default(),
        icon: MUTED,
        placeholder: MUTED,
        value: TEXT,
        selection: SELECTION,
    }
}

pub fn editor(_: &Theme, status: text_editor::Status) -> text_editor::Style {
    text_editor::Style {
        background: Background::Color(BG_INPUT),
        border: border(if matches!(status, text_editor::Status::Focused { .. }) { ACCENT } else { BORDER }),
        placeholder: MUTED,
        value: TEXT,
        selection: SELECTION,
    }
}

/// The diff's text sits on the backdrop canvas, so it has no background of its own.
pub fn diff_editor(_: &Theme, _: text_editor::Status) -> text_editor::Style {
    text_editor::Style {
        background: Background::Color(Color::TRANSPARENT),
        border: Border::default(),
        placeholder: MUTED,
        value: TEXT,
        selection: SELECTION,
    }
}

pub fn select(_: &Theme, status: pick_list::Status) -> pick_list::Style {
    pick_list::Style {
        text_color: TEXT,
        placeholder_color: MUTED,
        handle_color: TEXT,
        background: Background::Color(BG_INPUT),
        border: border(if matches!(status, pick_list::Status::Opened { .. }) { ACCENT } else { BORDER }),
    }
}

pub fn menu(_: &Theme) -> iced::overlay::menu::Style {
    iced::overlay::menu::Style {
        background: Background::Color(BG_MENU),
        border: border(BORDER_MENU),
        text_color: TEXT,
        selected_text_color: TEXT_STRONG,
        selected_background: Background::Color(BG_HOVER),
        shadow: Shadow::default(),
    }
}

pub fn check(_: &Theme, status: checkbox::Status) -> checkbox::Style {
    let checked = match status {
        checkbox::Status::Active { is_checked } | checkbox::Status::Hovered { is_checked } | checkbox::Status::Disabled { is_checked } => {
            is_checked
        }
    };
    checkbox::Style {
        background: Background::Color(if checked { ACCENT } else { BG_INPUT }),
        icon_color: WHITE,
        border: border(if checked { ACCENT } else { MUTED }),
        text_color: Some(MUTED),
    }
}

/// Thin scrollbars like the Electron app's (`--scrollbar`).
pub fn scrollbar(_: &Theme, status: scrollable::Status) -> scrollable::Style {
    let hover = matches!(status, scrollable::Status::Hovered { .. } | scrollable::Status::Dragged { .. });
    let rail = scrollable::Rail {
        background: None,
        border: Border::default(),
        scroller: scrollable::Scroller {
            background: Background::Color(if hover { SCROLLBAR_HOVER } else { SCROLLBAR }),
            border: Border { radius: 0.0.into(), ..Border::default() },
        },
    };
    scrollable::Style {
        container: container::Style::default(),
        vertical_rail: rail,
        horizontal_rail: rail,
        gap: None,
        auto_scroll: scrollable::AutoScroll {
            background: Background::Color(BG_MENU),
            border: border(BORDER),
            shadow: Shadow::default(),
            icon: TEXT,
        },
    }
}

/// `.toast`; the coloured left edge is drawn by the caller.
pub fn toast(_: &Theme) -> container::Style {
    container::Style {
        background: Some(Background::Color(BG_MENU)),
        border: border(BORDER_MENU),
        shadow: Shadow { color: Color::from_rgba(0.0, 0.0, 0.0, 0.4), offset: Vector::new(0.0, 10.0), blur_radius: 30.0 },
        ..Default::default()
    }
}
