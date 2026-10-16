/**
 * An agent's turn, read off the OSC 9;4 progress it emits (issue #294).
 *
 * omp has no hooks wmux can install (they are per-project, see omp-context.ts)
 * and no detection manifest, so its pane said only "the shell is running" —
 * "Running" while it sat waiting for input. But omp emits `OSC 9;4;3` when a
 * turn starts and `OSC 9;4;0` when it ends (its "terminal progress" setting),
 * and wmux was already drawing that as the row's progress bar. The status text
 * and the bar disagreed because only the bar listened.
 *
 * The signal is only trusted where it can mean a turn:
 *
 *  - The pane runs an IDENTIFIED agent (the command line named it). `winget`
 *    or `cargo` emitting progress and clearing it says nothing about idleness.
 *  - The program has emitted progress during THIS run. Silence is not idleness:
 *    an agent with the setting off never emits, and must keep reading as
 *    "Running" rather than be declared idle. A fresh session that has not run
 *    its first turn yet is in the same position, and stays there.
 *  - It only fills a screen verdict of `unknown`. A matched manifest rule saw
 *    the screen and is the finer fact.
 *
 * It enters through the detection loop, as a detected (never declared) state,
 * so every consumer — the workspace row, the roster, the tab dot — gets it
 * from the same place, and declared state still beats it.
 */
import type { DetectionResult } from '../../shared/detection/types';

export type ProgressTurn = 'working' | 'idle';

/** surfaceId → is progress up right now. Present only once it has been. */
const turns = new Map<string, boolean>();

/** OSC 9;4 state: 0 clears, anything else is work in progress. */
export function noteSurfaceProgress(surfaceId: string, state: number): void {
  if (state === 0) {
    if (turns.has(surfaceId)) turns.set(surfaceId, false);
    return;
  }
  turns.set(surfaceId, true);
}

/** The program exited back to its shell, or the PTY is gone. */
export function forgetProgressTurn(surfaceId: string): void {
  turns.delete(surfaceId);
}

export function progressTurnState(surfaceId: string): ProgressTurn | null {
  const active = turns.get(surfaceId);
  if (active === undefined) return null;
  return active ? 'working' : 'idle';
}

/** The screen verdict, completed by the turn signal where it may speak. */
export function withProgressTurn(
  result: DetectionResult,
  kind: string | null,
  turn: ProgressTurn | null,
): DetectionResult {
  if (result.state !== 'unknown' || !kind || !turn) return result;
  return {
    agent: kind,
    state: turn,
    ruleId: `osc-9-4.${turn}`,
    reason: 'matched',
    manifestVersion: null,
    evidence: [],
  };
}

/** Tests only. */
export function resetProgressTurns(): void {
  turns.clear();
}
