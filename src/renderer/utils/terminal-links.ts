import type { ILinkHandler } from '@xterm/xterm';
import { openInWmuxBrowser } from './open-in-browser';

/** xterm's `terminal.modes.mouseTrackingMode` — public API since xterm 5. */
export type MouseTrackingMode = 'none' | 'x10' | 'vt200' | 'drag' | 'any';

/**
 * What a click on a terminal link means: ignore it, or open it with or without
 * inverting the configured destination.
 *
 * Who owns a PLAIN click is the whole question (#280). When the program in the
 * pane has turned mouse tracking on, the click is also being reported to it —
 * xterm 6's Linkifier activates on an unmodified mouseup with no regard for
 * that — and a TUI that handles links itself (OpenCode v2 opens them with the
 * `open` package) then opens the same URL a second time, in the system
 * browser, beside the panel wmux just opened. Two openers, neither able to see
 * the other. Every mainstream terminal avoids this the same way: a plain click
 * belongs to an app that has captured the mouse, and the terminal's own link
 * handling waits for a modifier (Windows Terminal and VS Code Ctrl+click,
 * iTerm2 Cmd+click). So with tracking on, an unmodified click is the app's.
 *
 * And in that pane the modifier OPENS rather than inverts. Under #201 Ctrl
 * inverts `openLinksExternally` because a plain click already reaches the
 * default destination; with tracking on, Ctrl is the only way to reach wmux at
 * all, so if it still inverted, the panel (the default) would be unreachable
 * from every mouse-capturing pane — and in OpenCode, whose plain click already
 * opens the system browser, both gestures would land in the same place.
 *
 * Shell output (tracking off) is unchanged: plain click → default destination,
 * Ctrl/Cmd → the other one.
 */
export function linkClickTarget(
  modifier: boolean,
  mouseTracking: MouseTrackingMode,
): { invert: boolean } | null {
  if (mouseTracking === 'none') return { invert: modifier };
  return modifier ? { invert: false } : null;
}

/** Route terminal links through wmux instead of xterm's window.open fallback. */
export function activateTerminalLink(event: MouseEvent, uri: string, mouseTracking: MouseTrackingMode = 'none'): void {
  let protocol: string;
  try {
    protocol = new URL(uri).protocol;
  } catch {
    return;
  }

  if (protocol !== 'http:' && protocol !== 'https:') return;

  // Report only whether to invert. Whether that means "panel" or "system
  // browser" depends on browserPrefs.openLinksExternally, and that rule lives
  // in openInWmuxBrowser (issue #201).
  const target = linkClickTarget(!!event?.ctrlKey || !!event?.metaKey, mouseTracking);
  if (!target) return;
  openInWmuxBrowser(uri, target);
}

/**
 * One terminal's link activation, for BOTH of xterm's link sources — the OSC 8
 * provider (reads `Terminal.options.linkHandler`) and the WebLinksAddon — so a
 * URL behaves the same whichever of them found it. The mouse mode is read at
 * click time, never captured: an app turns tracking on and off for its whole
 * life, and the pane outlives the app.
 */
export function createTerminalLinkActivation(getMouseTracking: () => MouseTrackingMode): {
  activate: (event: MouseEvent, uri: string) => void;
  linkHandler: ILinkHandler;
} {
  const activate = (event: MouseEvent, uri: string) => activateTerminalLink(event, uri, getMouseTracking());
  return { activate, linkHandler: { activate } };
}
