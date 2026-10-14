import { beforeEach, describe, expect, it, vi } from 'vitest';

const { openInWmuxBrowser } = vi.hoisted(() => ({
  openInWmuxBrowser: vi.fn(),
}));

vi.mock('../../src/renderer/utils/open-in-browser', () => ({
  openInWmuxBrowser,
}));

import {
  activateTerminalLink,
  createTerminalLinkActivation,
  linkClickTarget,
  type MouseTrackingMode,
} from '../../src/renderer/utils/terminal-links';

function mouseEvent(modifiers: Partial<Pick<MouseEvent, 'ctrlKey' | 'metaKey'>> = {}): MouseEvent {
  return {
    ctrlKey: false,
    metaKey: false,
    ...modifiers,
  } as MouseEvent;
}

describe('terminal link handling', () => {
  beforeEach(() => {
    openInWmuxBrowser.mockReset();
  });

  // This module reports only WHETHER to invert. Since issue #201 the meaning
  // of that lives in openInWmuxBrowser, because it depends on
  // browserPrefs.openLinksExternally — so an unmodified click is `invert:
  // false`, not "open in the panel".
  it('reports an unmodified HTTP(S) click as no inversion', () => {
    activateTerminalLink(mouseEvent(), 'https://example.com/path');

    expect(openInWmuxBrowser).toHaveBeenCalledWith('https://example.com/path', {
      invert: false,
    });
  });

  it.each([
    { ctrlKey: true },
    { metaKey: true },
  ])('reports a modified click as an inversion: %o', modifiers => {
    activateTerminalLink(mouseEvent(modifiers), 'https://example.com');

    expect(openInWmuxBrowser).toHaveBeenCalledWith('https://example.com', {
      invert: true,
    });
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>1</script>',
    'file:///C:/Windows/win.ini',
    'not a URL',
  ])('rejects unsafe or invalid targets: %s', uri => {
    activateTerminalLink(mouseEvent(), uri);

    expect(openInWmuxBrowser).not.toHaveBeenCalled();
  });
});

// #280: OpenCode v2 opens a plainly-clicked link itself, so wmux opening it
// too meant two browsers for one click.
describe('a pane whose app has captured the mouse (#280)', () => {
  beforeEach(() => {
    openInWmuxBrowser.mockReset();
  });

  const TRACKING: MouseTrackingMode[] = ['x10', 'vt200', 'drag', 'any'];

  it.each(TRACKING)('a plain click is the app\'s (%s): wmux opens nothing', mode => {
    activateTerminalLink(mouseEvent(), 'https://example.com', mode);
    expect(openInWmuxBrowser).not.toHaveBeenCalled();
  });

  it.each(TRACKING)('Ctrl+click reaches wmux and opens the DEFAULT destination (%s)', mode => {
    // Not an inversion: with tracking on, the modifier is the only way to
    // reach wmux at all, so inverting would make the default destination —
    // the panel, out of the box — unreachable from every such pane.
    activateTerminalLink(mouseEvent({ ctrlKey: true }), 'https://example.com', mode);
    expect(openInWmuxBrowser).toHaveBeenCalledWith('https://example.com', { invert: false });
  });

  it('Cmd counts as the modifier too', () => {
    activateTerminalLink(mouseEvent({ metaKey: true }), 'https://example.com', 'any');
    expect(openInWmuxBrowser).toHaveBeenCalledWith('https://example.com', { invert: false });
  });

  it('the full decision table', () => {
    expect(linkClickTarget(false, 'none')).toEqual({ invert: false });
    expect(linkClickTarget(true, 'none')).toEqual({ invert: true });
    expect(linkClickTarget(false, 'vt200')).toBeNull();
    expect(linkClickTarget(true, 'vt200')).toEqual({ invert: false });
  });
});

describe('createTerminalLinkActivation', () => {
  beforeEach(() => {
    openInWmuxBrowser.mockReset();
  });

  it('the OSC 8 handler and the WebLinksAddon callback are the same function', () => {
    const links = createTerminalLinkActivation(() => 'none');
    expect(links.linkHandler.activate).toBe(links.activate);
  });

  it('reads the mouse mode at click time, not at creation', () => {
    // The pane outlives the app: tracking goes on when OpenCode starts and off
    // when it exits, and a captured value would be wrong for one of them.
    let mode: MouseTrackingMode = 'none';
    const links = createTerminalLinkActivation(() => mode);

    links.activate(mouseEvent(), 'https://a.example');
    expect(openInWmuxBrowser).toHaveBeenCalledTimes(1);

    mode = 'any';
    links.activate(mouseEvent(), 'https://b.example');
    expect(openInWmuxBrowser).toHaveBeenCalledTimes(1);

    mode = 'none';
    links.activate(mouseEvent(), 'https://c.example');
    expect(openInWmuxBrowser).toHaveBeenCalledTimes(2);
  });
});
