import { SplitNode, SurfaceId, PaneId } from '../../shared/types';
import { AgentMeta } from './agent-slice';
import type { TranslationKey } from '../i18n/core';

type T = (key: TranslationKey, fallback?: string) => string;
const identityT: T = (_key, fallback) => fallback ?? _key;

/** One display line under a workspace row. */
export interface WorkspaceAgent {
  key: string;
  name: string;
  detail: string;
  done: boolean;
  /** Set only for wmux-spawned agents that own a pane — makes the line clickable. */
  paneId?: PaneId;
  /** Tool-use count of an observer-parsed agent — feeds the "+N more" summary. */
  toolUses?: number;
  /** A background shell (#276): drawn like an agent, counted apart from them. */
  shell?: boolean;
}

/** Observer agent shape (subset of ClaudeActivity from src/main/claude-observer.ts). */
interface ObserverAgent {
  name: string;
  toolUses: number;
  tokens: string;
  done: boolean;
  /** Declared subagent (#272) — see AgentActivity in claude-observer.ts. */
  id?: string;
  detail?: string;
  touchedAt?: number;
  /** `shell`: a background shell, not a subagent (#276). */
  kind?: 'shell';
}

interface ObserverActivity {
  agents: ObserverAgent[];
  lastUpdate: number;
}

const OBSERVER_TTL_MS = 5 * 60 * 1000; // stale observer data never renders (ghost guard)
/**
 * A declared subagent that has said nothing for this long is not drawn as
 * running. Its stop can be lost (an Esc mid-subagent, a crashed producer), and
 * since the parent's Stop no longer ends it, silence is the only evidence left.
 * Longer than OBSERVER_TTL_MS because a subagent inside one slow tool is quiet
 * for the whole of it; any report brings the line straight back.
 */
export const DECLARED_SUBAGENT_TTL_MS = 10 * 60 * 1000;

/**
 * The ghost guard for a background shell (#276). A shell says nothing while it
 * runs — there is no heartbeat to miss — so the subagent TTL above would drop a
 * test suite at its tenth minute. Its end is reported by Claude Code itself
 * (the task notification, TaskStop, SessionEnd), so this only bounds the case
 * where every one of those was lost, e.g. Claude Code killed outright.
 */
export const BACKGROUND_SHELL_TTL_MS = 12 * 60 * 60 * 1000;

function isLive(a: ObserverAgent, now: number): boolean {
  const ttl = a.kind === 'shell' ? BACKGROUND_SHELL_TTL_MS : DECLARED_SUBAGENT_TTL_MS;
  return a.done || now - (a.touchedAt ?? 0) <= ttl;
}

/** Background shells still running in one pane (#276). */
export function runningBackgroundShells(activity: ObserverActivity | undefined, now: number): number {
  if (!activity) return 0;
  return activity.agents.filter(a => a.id && a.kind === 'shell' && !a.done && isLive(a, now)).length;
}

function declaredLine(surfaceId: string, a: ObserverAgent, now: number, t: T): WorkspaceAgent | null {
  if (!isLive(a, now)) return null;
  const parts = [a.toolUses > 0 ? `⚒${a.toolUses}` : '', a.detail ?? ''].filter(Boolean);
  const shell = a.kind === 'shell';
  return {
    key: `${surfaceId}#${a.id}`,
    name: shell ? t('agentView.backgroundShell', 'shell') : a.name,
    detail: a.done ? '✓' : parts.join(' · '),
    done: a.done,
    toolUses: a.toolUses,
    ...(shell ? { shell: true } : {}),
  };
}
const MAX_LINES = 4;
export const AGENT_LINGER_MS = 10_000;
/** Key of the synthetic "+N more" summary line appended when the list overflows. */
export const MORE_KEY = '__more';

function collectSurfacePanes(tree: SplitNode, out: Array<{ surfaceId: SurfaceId; paneId: PaneId }>): void {
  if (tree.type === 'leaf') {
    for (const s of tree.surfaces) out.push({ surfaceId: s.id, paneId: tree.paneId });
    return;
  }
  collectSurfacePanes(tree.children[0], out);
  collectSurfacePanes(tree.children[1], out);
}

function observerLines(surfaceId: string, activity: ObserverActivity | undefined, now: number, t: T): WorkspaceAgent[] {
  if (!activity) return [];
  // Declared beats scraped, the #128 rule: once the pane names its subagents
  // itself, the screen parser's guesses about the same agents (under other
  // names — a description rather than a type) would only draw them twice.
  const declared = activity.agents.filter(a => a.id);
  if (declared.length > 0) {
    return declared.map(a => declaredLine(surfaceId, a, now, t)).filter((l): l is WorkspaceAgent => l !== null);
  }
  if (now - activity.lastUpdate > OBSERVER_TTL_MS) return [];
  return activity.agents.map(a => ({
    key: `${surfaceId}:${a.name}`,
    name: a.name,
    detail: a.done ? '✓' : `⚒${a.toolUses} · ${a.tokens}`,
    done: a.done,
    toolUses: a.toolUses,
  }));
}

function wmuxLine(surfaceId: string, paneId: PaneId, meta: AgentMeta | undefined): WorkspaceAgent | null {
  if (!meta) return null;
  const done = meta.status === 'exited';
  return { key: `wmux:${surfaceId}`, name: meta.label, detail: done ? '✓' : '', done, paneId };
}

function summarize(ordered: WorkspaceAgent[], t: T): WorkspaceAgent[] {
  if (ordered.length <= MAX_LINES) return ordered;
  const shown = ordered.slice(0, MAX_LINES - 1);
  const hidden = ordered.slice(MAX_LINES - 1);
  // Done observer agents contribute their toolUses too — the summary reads
  // "work done by hidden agents", not "work in flight".
  const hiddenTools = hidden.reduce((sum, a) => sum + (a.toolUses ?? 0), 0);
  shown.push({
    key: MORE_KEY,
    name: t('agentView.moreSummary', '+{n} more').replace('{n}', String(hidden.length)),
    detail: hiddenTools > 0 ? `⚒${hiddenTools}` : '',
    done: hidden.every(a => a.done),
  });
  return shown;
}

/** Agent list of one workspace, plus true counts unaffected by the display cap. */
export interface WorkspaceAgentsView {
  /** Display lines, running first, capped at MAX_LINES (last may be "+N more"). */
  lines: WorkspaceAgent[];
  /** True number of merged agents, before summarize() truncates. */
  total: number;
  /** True number of still-running agents, before summarize() truncates. Shells excluded. */
  running: number;
  /** Background shells still running (#276) — lines in `lines`, but not agents. */
  shells: number;
}

/**
 * Merge observer-parsed subagents and wmux-spawned agents of one workspace
 * into a single display list, running first, capped at MAX_LINES (3 agents +
 * one "+N more" summary when overflowing). `total`/`running` count the full
 * merged list so callers can report real numbers despite the cap.
 */
export function agentsForWorkspace(
  splitTree: SplitNode,
  claudeActivity: Record<string, ObserverActivity | undefined>,
  agentMeta: Map<SurfaceId, AgentMeta>,
  now: number,
  t: T = identityT,
): WorkspaceAgentsView {
  const pairs: Array<{ surfaceId: SurfaceId; paneId: PaneId }> = [];
  collectSurfacePanes(splitTree, pairs);

  const merged: WorkspaceAgent[] = [];
  for (const { surfaceId, paneId } of pairs) {
    merged.push(...observerLines(surfaceId, claudeActivity[surfaceId], now, t));
    const wmux = wmuxLine(surfaceId, paneId, agentMeta.get(surfaceId));
    if (wmux) merged.push(wmux);
  }

  // Stable partition: running agents first, done ones after.
  const runningLines = merged.filter(a => !a.done);
  const ordered = [...runningLines, ...merged.filter(a => a.done)];
  const shells = runningLines.filter(a => a.shell).length;
  return {
    lines: summarize(ordered, t),
    total: merged.filter(a => !a.shell).length,
    running: runningLines.length - shells,
    shells,
  };
}

/**
 * Linger state machine: agent lines stay visible while anything runs, then
 * linger AGENT_LINGER_MS after everything finished so the ✓s are seen, then
 * collapse. Pure — the caller stores doneAt and supplies the clock.
 */
export function resolveAgentLinger(
  allDone: boolean,
  prevDoneAt: number | null,
  now: number,
): { visible: boolean; doneAt: number | null } {
  if (!allDone) return { visible: true, doneAt: null };
  const doneAt = prevDoneAt ?? now;
  return { visible: now - doneAt <= AGENT_LINGER_MS, doneAt };
}
