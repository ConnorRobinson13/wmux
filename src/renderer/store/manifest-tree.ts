// The renderer's half of workspace manifests (#284): turning main's resolved
// plan into a split tree, and a live workspace back into the facts a manifest
// is written from. Pure — the store and the bridge are the callers.
//
// What a manifest pane becomes here carries NO startupCommands. Main types
// every manifest command itself, after `after`/`waitFor` say it may and only
// once the user has trusted that exact file — so nothing about them goes into
// the store, or into session.json, where a restart would replay them without
// asking again (a `git pull` may have changed the file since).

import { v4 as uuid } from 'uuid';
import type { ManifestWorkspaceSpec, SplitNode, SurfaceId, SurfaceRef } from '../../shared/types';
import { buildWorkspaceTree, getAllPaneIds } from './split-utils';

export type { ManifestWorkspaceSpec } from '../../shared/types';

function mapLeaves(tree: SplitNode, fn: (leaf: SplitNode & { type: 'leaf' }, index: number) => SplitNode): SplitNode {
  let index = 0;
  const walk = (node: SplitNode): SplitNode => {
    if (node.type === 'leaf') return fn(node, index++);
    return { ...node, children: [walk(node.children[0]), walk(node.children[1])] };
  };
  return walk(tree);
}

/**
 * One leaf per pane, in manifest order, then one more holding every browser
 * tab when there are any. Leaves are filled in the order getAllPaneIds walks
 * them, which is reading order for every layout buildWorkspaceTree makes.
 */
export function buildManifestTree(spec: ManifestWorkspaceSpec): { tree: SplitNode; surfaces: Record<string, SurfaceId> } {
  const tabs = spec.browser?.tabs ?? [];
  const leafCount = spec.panes.length + (tabs.length ? 1 : 0);
  const base = buildWorkspaceTree(leafCount, spec.layout ?? (leafCount <= 3 ? 'columns' : 'grid'));
  const surfaces: Record<string, SurfaceId> = {};
  const tree = mapLeaves(base, (leaf, i) => {
    const pane = spec.panes[i];
    if (pane) {
      const id = `surf-${uuid()}` as SurfaceId;
      surfaces[pane.key] = id;
      const surface: SurfaceRef = {
        id,
        type: 'terminal',
        cwd: pane.cwd,
        // A default, like a profile name (#291) — the program's OSC title wins.
        ...(pane.title ? { defaultTitle: pane.title } : {}),
        ...(Object.keys(pane.env).length ? { env: pane.env } : {}),
      };
      return { ...leaf, surfaces: [surface], activeSurfaceIndex: 0 };
    }
    if (tabs.length) {
      const browserSurfaces: SurfaceRef[] = tabs.map((url) => ({ id: `surf-${uuid()}` as SurfaceId, type: 'browser', url }));
      const active = Math.min(Math.max(spec.browser?.active ?? 0, 0), browserSurfaces.length - 1);
      return { ...leaf, surfaces: browserSurfaces, activeSurfaceIndex: active };
    }
    return leaf;
  });
  return { tree, surfaces };
}

/** A live pane as `wmux workspace save` sees it. */
export interface DescribedPane {
  title?: string;
  cwd?: string;
  startupCommands?: string[];
  env?: Record<string, string>;
}

/**
 * The facts of a live workspace a manifest is written from: each terminal
 * pane's ACTIVE terminal (its live cwd first), and every browser tab's url.
 * Markdown/code/prompts panes have no manifest form and are left out.
 */
export function describeWorkspaceTree(tree: SplitNode, findLeafOf: (paneId: string) => (SplitNode & { type: 'leaf' }) | null):
  { panes: DescribedPane[]; browserTabs: string[] } {
  const panes: DescribedPane[] = [];
  const browserTabs: string[] = [];
  for (const paneId of getAllPaneIds(tree)) {
    const leaf = findLeafOf(paneId);
    if (!leaf) continue;
    for (const s of leaf.surfaces) {
      if (s.type === 'browser' && s.url && /^https?:\/\//i.test(s.url)) browserTabs.push(s.url);
    }
    const active = leaf.surfaces[leaf.activeSurfaceIndex];
    const terminal = active?.type === 'terminal' ? active : leaf.surfaces.find((s) => s.type === 'terminal');
    if (!terminal) continue;
    panes.push({
      title: terminal.customTitle ?? terminal.defaultTitle,
      cwd: terminal.currentCwd ?? terminal.cwd,
      startupCommands: terminal.startupCommands,
      env: terminal.env,
    });
  }
  return { panes, browserTabs };
}
