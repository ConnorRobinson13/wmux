/**
 * Ask App.tsx to write session.json NOW instead of on the next 30 s auto-save
 * tick (issue #285). For edits a user makes deliberately and expects to keep —
 * the per-pane startup command — where "it is in the store" is not the same as
 * "it survives a restart". A DOM event rather than a store field: it is a
 * one-shot request with no state, and App.tsx already owns the payload.
 */
export const SESSION_SAVE_NOW_EVENT = 'wmux:session-save-now';

export function requestSessionSaveNow(): void {
  window.dispatchEvent(new Event(SESSION_SAVE_NOW_EVENT));
}
