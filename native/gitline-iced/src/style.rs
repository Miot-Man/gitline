// The Electron app's dark theme tokens (src/styles.css :root), fonts and flat widget styles.
use iced::widget::{button, container, text_editor, text_input};
use iced::{Background, Border, Color, Font, Theme, font};

pub const fn hex(c: u32) -> Color {
    Color::from_rgb8((c >> 16) as u8, (c >> 8) as u8, c as u8)
}

pub const fn hexa(c: u32, a: f32) -> Color {
    Color::from_rgba8((c >> 16) as u8, (c >> 8) as u8, c as u8, a)
}

pub const BG: Color = hex(0x0e1114);
pub const BG_GRAPH: Color = hex(0x13171b);
pub const BG_PANEL: Color = hex(0x161a1f);
pub const BG_PANEL_2: Color = hex(0x1c2127);
pub const BG_HOVER: Color = hex(0x20262d);
pub const BG_ACTIVE: Color = hex(0x1d3836);
pub const BG_INPUT: Color = hex(0x0f1215);
pub const BORDER: Color = hex(0x2a3138);
pub const BORDER_SOFT: Color = hex(0x20262c);
pub const TEXT: Color = hex(0xdfe3e7);
pub const TEXT_STRONG: Color = hex(0xf5f7f9);
pub const MUTED: Color = hex(0x8b949e);
pub const ACCENT: Color = hex(0x2ec4b6);
pub const ACCENT_STRONG: Color = hex(0x22a597);
pub const GREEN: Color = hex(0x4cc38a);
pub const RED: Color = hex(0xef6f6c);
pub const YELLOW: Color = hex(0xe3b341);
pub const ORANGE: Color = hex(0xf4a259);
pub const ROW_HOVER: Color = Color::from_rgba(1.0, 1.0, 1.0, 0.035);
pub const LN: Color = hex(0x5d6370);
pub const LN_BG: Color = Color::from_rgba(0.0, 0.0, 0.0, 0.12);
pub const ADD_BG: Color = hexa(0x3fb34f, 0.16);
pub const ADD_LN_BG: Color = hexa(0x3fb34f, 0.22);
pub const ADD_SIGN: Color = hex(0x6fd37b);
pub const ADD_WORD: Color = hexa(0x3fb34f, 0.4);
pub const DEL_BG: Color = hexa(0xe5484d, 0.16);
pub const DEL_LN_BG: Color = hexa(0xe5484d, 0.22);
pub const DEL_SIGN: Color = hex(0xff7b80);
pub const DEL_WORD: Color = hexa(0xe5484d, 0.4);

pub const SANS: Font = Font::with_name("IBM Plex Sans");
pub const SANS_BOLD: Font = Font { weight: font::Weight::Semibold, ..SANS };
pub const MONO: Font = Font::with_name("JetBrains Mono");
pub const MONO_ITALIC: Font = Font { style: font::Style::Italic, ..MONO };

pub const FONTS: [&[u8]; 4] = [
    include_bytes!("../../assets/fonts/IBMPlexSans-Regular.ttf"),
    include_bytes!("../../assets/fonts/IBMPlexSans-SemiBold.ttf"),
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

/// Flat, square buttons as in the Electron app.
pub fn flat(_: &Theme, status: button::Status) -> button::Style {
    let background = match status {
        button::Status::Hovered | button::Status::Pressed => BG_HOVER,
        _ => BG_PANEL_2,
    };
    button::Style {
        background: Some(Background::Color(background)),
        text_color: if status == button::Status::Disabled { MUTED } else { TEXT },
        border: Border { color: BORDER, width: 1.0, radius: 0.0.into() },
        ..Default::default()
    }
}

pub fn primary(_: &Theme, status: button::Status) -> button::Style {
    let (background, text) = match status {
        button::Status::Disabled => (Color::TRANSPARENT, MUTED),
        button::Status::Hovered | button::Status::Pressed => (ACCENT_STRONG, BG),
        button::Status::Active => (ACCENT, BG),
    };
    button::Style {
        background: Some(Background::Color(background)),
        text_color: text,
        border: Border { color: if status == button::Status::Disabled { BORDER } else { ACCENT }, width: 1.0, radius: 0.0.into() },
        ..Default::default()
    }
}

/// A list row: no chrome, a hover tint, and the active colour when open/selected.
pub fn row_button(active: bool) -> impl Fn(&Theme, button::Status) -> button::Style {
    move |_, status| button::Style {
        background: Some(Background::Color(if active {
            BG_ACTIVE
        } else if matches!(status, button::Status::Hovered) {
            BG_HOVER
        } else {
            Color::TRANSPARENT
        })),
        text_color: TEXT,
        border: Border::default(),
        ..Default::default()
    }
}

pub fn panel(color: Color) -> impl Fn(&Theme) -> container::Style {
    move |_| container::Style { background: Some(Background::Color(color)), ..Default::default() }
}

pub fn header(_: &Theme) -> container::Style {
    container::Style {
        background: Some(Background::Color(BG_PANEL_2)),
        border: Border { color: BORDER_SOFT, width: 0.0, radius: 0.0.into() },
        ..Default::default()
    }
}

pub fn input(_: &Theme, status: text_input::Status) -> text_input::Style {
    text_input::Style {
        background: Background::Color(BG_INPUT),
        border: Border {
            color: if matches!(status, text_input::Status::Focused { .. }) { ACCENT } else { BORDER },
            width: 1.0,
            radius: 0.0.into(),
        },
        icon: MUTED,
        placeholder: MUTED,
        value: TEXT,
        selection: hexa(0x2ec4b6, 0.35),
    }
}

pub fn editor(_: &Theme, status: text_editor::Status) -> text_editor::Style {
    text_editor::Style {
        background: Background::Color(BG_INPUT),
        border: Border {
            color: if matches!(status, text_editor::Status::Focused { .. }) { ACCENT } else { BORDER },
            width: 1.0,
            radius: 0.0.into(),
        },
        placeholder: MUTED,
        value: TEXT,
        selection: hexa(0x2ec4b6, 0.35),
    }
}

/// The diff's text sits on the backdrop canvas, so it has no background of its own.
pub fn diff_editor(_: &Theme, _: text_editor::Status) -> text_editor::Style {
    text_editor::Style {
        background: Background::Color(Color::TRANSPARENT),
        border: Border::default(),
        placeholder: MUTED,
        value: TEXT,
        selection: hexa(0x2ec4b6, 0.35),
    }
}
