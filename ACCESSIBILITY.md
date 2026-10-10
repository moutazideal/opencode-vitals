# Accessibility

This plugin cares about accessibility for the same reason it exists: reading
OpenCode should not depend on the language you write in. Two commitments sit
behind that.

1. **Arabic reads correctly.** Arabic text should be laid out right-to-left, in
   the order it is meant to be read, without the code and English inside a reply
   dragging it the wrong way. That is the whole point of the Arabic fix, and it is
   a reading-accessibility feature, not a decoration.
2. **Nothing this plugin adds should get in the way.** The readout is plain text
   in a row you already look at. It takes no focus, catches no clicks, and adds no
   motion. If any part of it ever makes OpenCode harder to use, that is a bug.

## Supported environment

OpenCode V2 Desktop on Linux. The window is OpenCode's own, so the accessibility
of the editor itself — screen-reader support, keyboard navigation, focus order,
zoom — is OpenCode's, and is reported to OpenCode. This plugin only adds a line of
text and fixes text direction inside that window.

## Known limitations

Stated plainly, because a limitation you cannot see is one you cannot report:

- **Linux only, for now.** The piece that makes the app load the fixed renderer
  is a `.desktop` entry, which macOS and Windows do not have. On those platforms
  the plugin installs and measures but cannot make the window use it. See
  [Platform support](README.md#platform-support).
- **The readout is decorative text.** It is drawn with `pointer-events: none` and
  `user-select: none`, it is not a form control, and it has no live region, so a
  screen reader will likely not announce it and it cannot be tabbed to. It updates
  about once a second without speaking. Treat it as something to glance at, not as
  an interactive element.
- **The readout's colours are OpenCode's.** It uses the app's own theme variables,
  so its contrast is the app's contrast, at whatever theme and zoom you have set.
- **Arabic fixes direction, not type.** It sets text direction and alignment. It
  does not choose or bundle a font; glyph shaping and font choice remain the app's
  and the system's.
- **The interface is not mirrored.** Only message text and the prompt box change
  direction. The sidebar, menus and titlebar keep the layout OpenCode gave them.

## Reporting a barrier

If something here is a barrier to you — text you cannot read, direction that is
still wrong, a screen reader that behaves badly, a colour or size that fails you —
please open an issue:

**[Report an accessibility barrier](https://github.com/moutazideal/opencode-vitals/issues/new)**

Say what you were doing, which assistive technology or display settings you use
(screen reader and version, zoom level, theme, high-contrast mode), and what you
expected. A screenshot is welcome. Please do not paste conversation text; this
plugin does not store it and neither should a report.

Contributions that improve accessibility are welcome — see
[CONTRIBUTING.md](CONTRIBUTING.md).
