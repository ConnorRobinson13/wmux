/**
 * Each terminal's own shell state, and the workspace state derived from them
 * (issue #294).
 *
 * `WorkspaceInfo.shellState` used to be written straight from every
 * `report_shell_state`, so it was a last-writer-wins field shared by every pane
 * in the workspace. A long command in one pane — an agent TUI like omp, which
 * has no hooks and is visible to wmux only as "the shell is running" — was
 * overwritten the moment ANY other pane reached its prompt, or exited, and the
 * row read "Idle" while the agent was visibly generating.
 *
 * So the facts are kept per surface and the workspace field becomes a
 * derivation: running while any of its surfaces runs, otherwise whatever the
 * reporting surface just went to. The workspace field is still the one every
 * consumer reads; only its writer changed.
 *
 * A module map rather than store state, like `surfaceMouseModes`: nothing
 * renders from the per-surface value, and the derived workspace field is the
 * store write that re-renders the row.
 */
import type { SplitNode } from '../../shared/types';

export type ShellState = 'idle' | 'running' | 'interrupted';

const states = new Map<string, ShellState>();

/** The state this surface reported last, before the report being applied. */
export function previousSurfaceShellState(surfaceId: string): ShellState | undefined {
  return states.get(surfaceId);
}

export function recordSurfaceShellState(surfaceId: string, state: ShellState): void {
  states.set(surfaceId, state);
}

/** The surface's PTY is gone: it cannot be the running command any more. */
export function forgetSurfaceShellState(surfaceId: string): void {
  states.delete(surfaceId);
}

/**
 * The workspace's state, given the surfaces it holds NOW and the state the
 * reporting surface just went to. Only current surfaces count, so an entry left
 * behind by a tab that moved to another workspace cannot hold this one on
 * "running".
 */
export function workspaceShellState(surfaceIds: readonly string[], latest: ShellState): ShellState {
  return surfaceIds.some((id) => states.get(id) === 'running') ? 'running' : latest;
}

/** Every surface id in a split tree. */
export function treeSurfaceIds(tree: SplitNode): string[] {
  if (tree.type === 'leaf') return tree.surfaces.map((s) => s.id);
  return [...treeSurfaceIds(tree.children[0]), ...treeSurfaceIds(tree.children[1])];
}

/** Tests only. */
export function resetSurfaceShellStates(): void {
  states.clear();
}
