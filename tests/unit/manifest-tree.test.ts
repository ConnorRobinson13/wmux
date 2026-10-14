import { describe, it, expect } from 'vitest';
import { buildManifestTree, describeWorkspaceTree } from '../../src/renderer/store/manifest-tree';
import { findLeaf, getAllPaneIds } from '../../src/renderer/store/split-utils';
import type { SplitNode, SurfaceRef } from '../../src/shared/types';

/** #284 — the renderer's half: a resolved manifest becomes a split tree. */

function leaves(tree: SplitNode) {
  return getAllPaneIds(tree).map((id) => findLeaf(tree, id)!);
}

const spec = {
  title: 'demo',
  cwd: 'C:\\repo',
  panes: [
    { key: 'db', title: 'db', cwd: 'C:\\repo', env: {} },
    { key: 'api', title: 'API', cwd: 'C:\\repo\\apps\\api', env: { PORT: '4000' } },
  ],
  browser: { tabs: ['http://localhost:5173/', 'http://localhost:4000/docs'], active: 1 },
};

describe('buildManifestTree', () => {
  it('one pane per manifest pane in order, then one pane holding every browser tab', () => {
    const { tree, surfaces } = buildManifestTree(spec);
    const ls = leaves(tree);
    expect(ls).toHaveLength(3);
    expect(ls[0].surfaces[0]).toMatchObject({ id: surfaces.db, type: 'terminal', cwd: 'C:\\repo', customTitle: 'db' });
    expect(ls[1].surfaces[0]).toMatchObject({ id: surfaces.api, cwd: 'C:\\repo\\apps\\api', env: { PORT: '4000' } });
    expect(ls[2].surfaces.map((s) => [s.type, s.url])).toEqual([
      ['browser', 'http://localhost:5173/'],
      ['browser', 'http://localhost:4000/docs'],
    ]);
    expect(ls[2].activeSurfaceIndex).toBe(1);
  });

  it('carries NO startup commands into the store — main types them after trust, and session.json must never replay them', () => {
    const { tree } = buildManifestTree(spec);
    const all: SurfaceRef[] = leaves(tree).flatMap((l) => l.surfaces);
    expect(all.every((s) => s.startupCommands === undefined)).toBe(true);
  });

  it('every surface id is fresh and unique', () => {
    const a = buildManifestTree(spec);
    const b = buildManifestTree(spec);
    expect(Object.values(a.surfaces)).not.toEqual(Object.values(b.surfaces));
    expect(new Set(Object.values(a.surfaces)).size).toBe(2);
  });

  it('no browser tabs → no browser pane', () => {
    expect(leaves(buildManifestTree({ ...spec, browser: undefined }).tree)).toHaveLength(2);
  });
});

describe('describeWorkspaceTree (what `wmux workspace save` writes from)', () => {
  it('takes each pane\'s live cwd, its startup commands and env, and every browser url', () => {
    const { tree } = buildManifestTree(spec);
    const ls = leaves(tree);
    ls[0].surfaces[0].currentCwd = 'C:\\repo\\infra';
    ls[1].surfaces[0].startupCommands = ['npm run dev'];
    const d = describeWorkspaceTree(tree, (id) => findLeaf(tree, id as never) ?? null);
    expect(d.panes).toEqual([
      { title: 'db', cwd: 'C:\\repo\\infra', startupCommands: undefined, env: undefined },
      { title: 'API', cwd: 'C:\\repo\\apps\\api', startupCommands: ['npm run dev'], env: { PORT: '4000' } },
    ]);
    expect(d.browserTabs).toEqual(['http://localhost:5173/', 'http://localhost:4000/docs']);
  });
});
