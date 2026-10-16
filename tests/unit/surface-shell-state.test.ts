import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordSurfaceShellState,
  forgetSurfaceShellState,
  workspaceShellState,
  previousSurfaceShellState,
  resetSurfaceShellStates,
} from '../../src/renderer/utils/surface-shell-state';

// Issue #294: the workspace's shell state was ONE last-writer-wins field, so
// any other pane reaching its prompt overwrote the "running" of the pane whose
// long command (an agent TUI) was still going, and the row read "Idle".
describe('workspaceShellState (#294)', () => {
  beforeEach(() => resetSurfaceShellStates());

  it('stays running while ANY pane still runs, whoever reported last', () => {
    recordSurfaceShellState('surf-omp', 'running');
    recordSurfaceShellState('surf-other', 'idle');
    expect(workspaceShellState(['surf-omp', 'surf-other'], 'idle')).toBe('running');
  });

  it('reads the reporting pane once nothing runs', () => {
    recordSurfaceShellState('surf-a', 'idle');
    recordSurfaceShellState('surf-b', 'interrupted');
    expect(workspaceShellState(['surf-a', 'surf-b'], 'interrupted')).toBe('interrupted');
  });

  it('ignores a running entry for a surface no longer in the workspace', () => {
    recordSurfaceShellState('surf-gone', 'running');
    recordSurfaceShellState('surf-a', 'idle');
    expect(workspaceShellState(['surf-a'], 'idle')).toBe('idle');
  });

  it('an exited pane stops counting as running, and only that pane', () => {
    recordSurfaceShellState('surf-a', 'running');
    recordSurfaceShellState('surf-b', 'running');
    forgetSurfaceShellState('surf-b');
    expect(workspaceShellState(['surf-a', 'surf-b'], 'idle')).toBe('running');
    forgetSurfaceShellState('surf-a');
    expect(workspaceShellState(['surf-a', 'surf-b'], 'idle')).toBe('idle');
  });

  it('remembers each pane\'s own previous state for the duration notice', () => {
    recordSurfaceShellState('surf-a', 'running');
    recordSurfaceShellState('surf-b', 'idle');
    expect(previousSurfaceShellState('surf-a')).toBe('running');
    expect(previousSurfaceShellState('surf-b')).toBe('idle');
    expect(previousSurfaceShellState('surf-never')).toBeUndefined();
  });
});
