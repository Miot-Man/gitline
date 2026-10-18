// Smooth wheel scrolling. iced's scrollable jumps a fixed 60px per mouse-wheel notch; Chromium (and so
// the Electron app) animates each notch, and notches in quick succession add up. `Wheel` wraps a
// scrollable and turns wheel notches into messages; `Smooth` animates the scroll offset towards the
// accumulated target, one frame at a time. Touchpads already send smooth pixel deltas (with the OS's
// own momentum), so those pass straight through to the scrollable.
use std::time::Instant;

use iced::advanced::widget::{Operation, Tree, tree};
use iced::advanced::{Clipboard, Layout, Shell, Widget, layout, mouse, overlay, renderer};
use iced::{Element, Event, Length, Rectangle, Renderer, Size, Theme, Vector};

/// Pixels per wheel notch: Chromium's 100px.
pub const NOTCH: f32 = 100.0;
/// Time constant of the ease-out: the offset covers ~95% of the way in 3τ (about 150ms).
const TAU: f32 = 0.05;

/// The animated offset of one scroll area.
#[derive(Debug, Clone, Copy, Default)]
pub struct Smooth {
    /// The offset the scrollable last reported.
    pub offset: f32,
    /// The largest offset (content height minus viewport height).
    pub max: f32,
    target: Option<f32>,
    last: Option<Instant>,
}

impl Smooth {
    /// Records where the scrollable is (from its `on_scroll`).
    pub fn scrolled(&mut self, offset: f32, max: f32) {
        self.offset = offset;
        self.max = max.max(0.0);
    }

    /// Adds `dy` pixels to where the animation is heading.
    pub fn wheel(&mut self, dy: f32) {
        let from = self.target.unwrap_or(self.offset);
        self.target = Some((from + dy).clamp(0.0, self.max));
    }

    pub fn animating(&self) -> bool {
        self.target.is_some()
    }

    /// Advances to `now`, returning the offset to scroll to (None when there's nothing to animate).
    pub fn tick(&mut self, now: Instant) -> Option<f32> {
        let target = self.target?;
        let dt = self.last.map_or(1.0 / 60.0, |l| now.duration_since(l).as_secs_f32()).min(0.1);
        self.last = Some(now);
        let next = self.offset + (target - self.offset) * (1.0 - (-dt / TAU).exp());
        if (target - next).abs() < 0.5 {
            self.target = None;
            self.last = None;
            self.offset = target;
        } else {
            self.offset = next;
        }
        Some(self.offset)
    }
}

/// Wraps `content` (a scrollable) and reports mouse-wheel notches over it as `on_wheel(pixels)`
/// instead of letting the scrollable jump.
pub struct Wheel<'a, Message> {
    content: Element<'a, Message>,
    on_wheel: Box<dyn Fn(f32) -> Message + 'a>,
}

pub fn wheel<'a, Message>(content: impl Into<Element<'a, Message>>, on_wheel: impl Fn(f32) -> Message + 'a) -> Wheel<'a, Message> {
    Wheel { content: content.into(), on_wheel: Box::new(on_wheel) }
}

impl<Message> Widget<Message, Theme, Renderer> for Wheel<'_, Message> {
    fn tag(&self) -> tree::Tag {
        tree::Tag::stateless()
    }

    fn children(&self) -> Vec<Tree> {
        vec![Tree::new(&self.content)]
    }

    fn diff(&self, tree: &mut Tree) {
        tree.diff_children(std::slice::from_ref(&self.content));
    }

    fn size(&self) -> Size<Length> {
        self.content.as_widget().size()
    }

    fn layout(&mut self, tree: &mut Tree, renderer: &Renderer, limits: &layout::Limits) -> layout::Node {
        self.content.as_widget_mut().layout(&mut tree.children[0], renderer, limits)
    }

    fn operate(&mut self, tree: &mut Tree, layout: Layout<'_>, renderer: &Renderer, operation: &mut dyn Operation) {
        self.content.as_widget_mut().operate(&mut tree.children[0], layout, renderer, operation);
    }

    fn update(
        &mut self,
        tree: &mut Tree,
        event: &Event,
        layout: Layout<'_>,
        cursor: mouse::Cursor,
        renderer: &Renderer,
        clipboard: &mut dyn Clipboard,
        shell: &mut Shell<'_, Message>,
        viewport: &Rectangle,
    ) {
        if let Event::Mouse(mouse::Event::WheelScrolled { delta: mouse::ScrollDelta::Lines { x, y } }) = event
            && x.abs() < y.abs()
            && cursor.is_over(layout.bounds())
        {
            shell.publish((self.on_wheel)(-y * NOTCH));
            shell.capture_event();
            return;
        }
        self.content.as_widget_mut().update(&mut tree.children[0], event, layout, cursor, renderer, clipboard, shell, viewport);
    }

    fn mouse_interaction(
        &self,
        tree: &Tree,
        layout: Layout<'_>,
        cursor: mouse::Cursor,
        viewport: &Rectangle,
        renderer: &Renderer,
    ) -> mouse::Interaction {
        self.content.as_widget().mouse_interaction(&tree.children[0], layout, cursor, viewport, renderer)
    }

    fn draw(
        &self,
        tree: &Tree,
        renderer: &mut Renderer,
        theme: &Theme,
        style: &renderer::Style,
        layout: Layout<'_>,
        cursor: mouse::Cursor,
        viewport: &Rectangle,
    ) {
        self.content.as_widget().draw(&tree.children[0], renderer, theme, style, layout, cursor, viewport);
    }

    fn overlay<'b>(
        &'b mut self,
        tree: &'b mut Tree,
        layout: Layout<'b>,
        renderer: &Renderer,
        viewport: &Rectangle,
        translation: Vector,
    ) -> Option<overlay::Element<'b, Message, Theme, Renderer>> {
        self.content.as_widget_mut().overlay(&mut tree.children[0], layout, renderer, viewport, translation)
    }
}

impl<'a, Message: 'a> From<Wheel<'a, Message>> for Element<'a, Message> {
    fn from(w: Wheel<'a, Message>) -> Self {
        Element::new(w)
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    #[test]
    fn eases_towards_the_accumulated_target() {
        let mut s = Smooth::default();
        s.scrolled(0.0, 1000.0);
        s.wheel(NOTCH);
        s.wheel(NOTCH); // a second notch before the first finished adds up
        let t0 = Instant::now();
        let mut offsets = Vec::new();
        for i in 1..=40 {
            if let Some(o) = s.tick(t0 + Duration::from_millis(16 * i)) {
                offsets.push(o);
            }
        }
        assert!(offsets.windows(2).all(|w| w[1] >= w[0]), "moves one way");
        assert!(offsets[0] < 100.0, "starts fast but not instantly");
        assert_eq!(*offsets.last().unwrap(), 200.0);
        assert!(!s.animating());
        assert!(offsets.len() < 20, "settles in well under half a second: {}", offsets.len());
    }

    #[test]
    fn stays_within_the_content() {
        let mut s = Smooth::default();
        s.scrolled(950.0, 1000.0);
        s.wheel(NOTCH);
        while s.tick(Instant::now()).is_some() && s.animating() {}
        assert_eq!(s.offset, 1000.0);
        s.wheel(-5000.0);
        assert!(s.animating());
        let t0 = Instant::now();
        let mut last = 0.0;
        for i in 1..100 {
            if let Some(o) = s.tick(t0 + Duration::from_millis(16 * i)) {
                last = o;
            }
        }
        assert_eq!(last, 0.0);
    }
}
