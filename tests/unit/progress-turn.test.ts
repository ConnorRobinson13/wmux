import { describe, it, expect, beforeEach } from 'vitest';
import {
  noteSurfaceProgress,
  forgetProgressTurn,
  progressTurnState,
  withProgressTurn,
  resetProgressTurns,
} from '../../src/renderer/utils/progress-turn';
import type { DetectionResult } from '../../src/shared/detection/types';

const UNKNOWN: DetectionResult = {
  agent: null, state: 'unknown', ruleId: null, reason: 'no-agent-signature', manifestVersion: null, evidence: [],
};

// Issue #294: omp has no hooks and no detection manifest, but it emits
// OSC 9;4;3 at agent_start and 9;4;0 at agent_end — a turn-level signal the
// sidebar's progress bar was already drawing while the status text ignored it.
describe('progress turn (#294)', () => {
  beforeEach(() => resetProgressTurns());

  it('says nothing for a surface that never emitted progress', () => {
    expect(progressTurnState('surf-a')).toBeNull();
    noteSurfaceProgress('surf-a', 0);
    expect(progressTurnState('surf-a')).toBeNull();
  });

  it('is working while progress is up, idle once it is cleared', () => {
    noteSurfaceProgress('surf-a', 3);
    expect(progressTurnState('surf-a')).toBe('working');
    noteSurfaceProgress('surf-a', 0);
    expect(progressTurnState('surf-a')).toBe('idle');
    noteSurfaceProgress('surf-a', 3);
    expect(progressTurnState('surf-a')).toBe('working');
  });

  it('forgets the run when the program exits back to the shell', () => {
    noteSurfaceProgress('surf-a', 3);
    noteSurfaceProgress('surf-a', 0);
    forgetProgressTurn('surf-a');
    expect(progressTurnState('surf-a')).toBeNull();
  });

  it('fills an unknown screen verdict for an IDENTIFIED agent', () => {
    const r = withProgressTurn(UNKNOWN, 'omp', 'working');
    expect(r.agent).toBe('omp');
    expect(r.state).toBe('working');
    expect(r.reason).toBe('matched');
    expect(r.ruleId).toBe('osc-9-4.working');
  });

  it('never invents an agent: no identity, no verdict', () => {
    expect(withProgressTurn(UNKNOWN, null, 'idle')).toBe(UNKNOWN);
  });

  it('never overrides what the screen actually matched', () => {
    const seen: DetectionResult = { ...UNKNOWN, agent: 'claude', state: 'blocked', ruleId: 'claude.blocked.permission', reason: 'matched' };
    expect(withProgressTurn(seen, 'claude', 'working')).toBe(seen);
  });

  it('leaves the verdict alone when there is no turn signal', () => {
    expect(withProgressTurn(UNKNOWN, 'omp', null)).toBe(UNKNOWN);
  });
});
