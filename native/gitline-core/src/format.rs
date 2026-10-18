// Display helpers, ported from src/lib/format.ts.

pub fn initials(name: &str) -> String {
    let parts: Vec<&str> = name.split_whitespace().collect();
    match parts.as_slice() {
        [] => "?".into(),
        [one] => one.chars().take(2).collect::<String>().to_uppercase(),
        [first, .., last] => format!("{}{}", first.chars().next().unwrap(), last.chars().next().unwrap()).to_uppercase(),
    }
}

/// "3 days ago", relative to `now` (both in seconds since the epoch).
pub fn relative_time(unix: i64, now: i64) -> String {
    let s = now - unix;
    if s < 60 {
        return "just now".into();
    }
    const UNITS: [(i64, &str); 6] =
        [(60, "minute"), (3600, "hour"), (86400, "day"), (604_800, "week"), (2_629_800, "month"), (31_557_600, "year")];
    let (secs, name) = UNITS.iter().rev().find(|(u, _)| s >= *u).copied().unwrap_or(UNITS[0]);
    let n = s / secs;
    format!("{n} {name}{} ago", if n == 1 { "" } else { "s" })
}

pub fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64)
}

/// `2024-03-05 14:07 UTC`. (The Electron app uses the locale's format and time zone; a time zone
/// database is more than the spike needs.)
pub fn format_date(unix: i64) -> String {
    let days = unix.div_euclid(86_400);
    let secs = unix.rem_euclid(86_400);
    // Civil-from-days (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02} UTC", secs / 3600, secs % 3600 / 60)
}

/// `("src/lib/", "graph.ts")`
pub fn split_path(p: &str) -> (&str, &str) {
    match p.rfind('/') {
        Some(i) => (&p[..=i], &p[i + 1..]),
        None => ("", p),
    }
}

/// Stable colour per author (hsl(h 55% 45%) as in the Electron app), as 0xRRGGBB.
pub fn author_color(email: &str) -> u32 {
    let mut h: i32 = 0;
    for c in email.encode_utf16() {
        h = h.wrapping_mul(31).wrapping_add(c as i32);
    }
    hsl_to_rgb((h.unsigned_abs() % 360) as f32, 0.55, 0.45)
}

fn hsl_to_rgb(h: f32, s: f32, l: f32) -> u32 {
    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let x = c * (1.0 - ((h / 60.0) % 2.0 - 1.0).abs());
    let m = l - c / 2.0;
    let (r, g, b) = match (h / 60.0) as u32 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    let to = |v: f32| ((v + m) * 255.0).round() as u32;
    to(r) << 16 | to(g) << 8 | to(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn makes_initials() {
        assert_eq!(initials("Ada Park"), "AP");
        assert_eq!(initials("ada"), "AD");
        assert_eq!(initials("Ada B. Park"), "AP");
        assert_eq!(initials("  "), "?");
    }

    #[test]
    fn says_how_long_ago() {
        assert_eq!(relative_time(1000, 1030), "just now");
        assert_eq!(relative_time(0, 60), "1 minute ago");
        assert_eq!(relative_time(0, 7200), "2 hours ago");
        assert_eq!(relative_time(0, 86400 * 9), "1 week ago");
        assert_eq!(relative_time(0, 31_557_600 * 3), "3 years ago");
    }

    #[test]
    fn formats_dates_in_utc() {
        assert_eq!(format_date(0), "1970-01-01 00:00 UTC");
        assert_eq!(format_date(1_709_647_620), "2024-03-05 14:07 UTC");
        assert_eq!(format_date(951_782_400), "2000-02-29 00:00 UTC");
    }

    #[test]
    fn splits_paths() {
        assert_eq!(split_path("src/lib/graph.ts"), ("src/lib/", "graph.ts"));
        assert_eq!(split_path("README.md"), ("", "README.md"));
    }

    #[test]
    fn colours_authors_stably() {
        assert_eq!(author_color("a@b.c"), author_color("a@b.c"));
        assert_ne!(author_color("a@b.c"), author_color("x@y.z"));
        assert_eq!(hsl_to_rgb(0.0, 1.0, 0.5), 0xff0000);
        assert_eq!(hsl_to_rgb(120.0, 1.0, 0.5), 0x00ff00);
    }
}
