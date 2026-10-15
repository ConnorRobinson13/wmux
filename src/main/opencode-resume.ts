// ─── OpenCode resume, main side (#290) ───────────────────────────────────────
//
// The third provider beside Claude (#186) and Codex (#261). The handle comes
// from wmux's own OpenCode plugin, which sees every session event and calls
// `wmux report-session <id> --provider opencode`; restore types
// `opencode -s <id>`. Same shape as codex-resume.ts on purpose — one stamp per
// provider, mutually exclusive through agent-session-persistence.ts.

import { SurfaceId } from '../shared/types';
import { mapSurfaces } from './claude-resume';

/**
 * OpenCode session ids are `ses_` + base62. Strict on purpose: the value
 * arrives over the pipe and ends up on a restored pane's command line, and
 * Claude's looser validator would accept one too — the prefix is what keeps
 * an OpenCode id from ever being typed after `claude --resume`.
 */
export const OPENCODE_SESSION_ID_RE = /^ses_[A-Za-z0-9]{8,120}$/;
export function isValidOpencodeSessionId(id: unknown): id is string {
  return typeof id === 'string' && OPENCODE_SESSION_ID_RE.test(id);
}

/**
 * `undefined` from the lookup means "no opinion" and keeps what the persisted
 * copy already had: a restored OpenCode that has not reported yet must not
 * lose its handle to the first auto-save.
 */
export function stampOpencodeSessionIds<T>(tree: T, lookup: (id: SurfaceId) => string | null | undefined): T {
  return mapSurfaces(tree, surface => {
    if (surface.type !== 'terminal') return surface;
    const found = lookup(surface.id as SurfaceId);
    if (found === undefined) return surface;
    const next = isValidOpencodeSessionId(found) ? found : undefined;
    if (next === surface.opencodeSessionId) return surface;
    if (next) return { ...surface, opencodeSessionId: next };
    const rest = { ...surface };
    delete rest.opencodeSessionId;
    return rest;
  });
}
