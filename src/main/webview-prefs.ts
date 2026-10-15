// The web preferences every browser-panel <webview> is attached with.
//
// Applied from `will-attach-webview`, which Electron emits on the HOST
// webContents — the wmux window that contains the <webview> tag — and never on
// the guest itself. Until #287 the listener was registered only on contents of
// type `webview`, i.e. on a guest, where it would fire only for a webview
// nested inside a web page: for every panel wmux actually draws it never ran.
// The hardening below was therefore dead code (the renderer happens not to set
// any of those attributes, which is why nothing broke), and the autoplay rule
// had nowhere to live.
//
// Autoplay (#287): Electron's default `autoplayPolicy` is
// `no-user-gesture-required`, so a page that asks for `autoplay` gets it WITH
// sound the moment it loads — a course page started talking in the panel while
// the same page in Edge sat behind a play button. Chrome's own default is that
// media with sound waits for the user to interact with the document, which is
// `document-user-activation-required`. Muted autoplay (background videos,
// previews) is unaffected by that policy, exactly as in Chrome.

export const WEBVIEW_AUTOPLAY_POLICY = 'document-user-activation-required' as const;

/** Mutates the preferences and params Electron hands `will-attach-webview`. */
export function hardenWebviewPreferences(
  webPreferences: Record<string, unknown>,
  params: Record<string, unknown>,
): void {
  delete webPreferences.preload;
  delete webPreferences.preloadURL;
  webPreferences.nodeIntegration = false;
  webPreferences.contextIsolation = true;
  webPreferences.autoplayPolicy = WEBVIEW_AUTOPLAY_POLICY;
  params.nodeintegration = 'false';
}
