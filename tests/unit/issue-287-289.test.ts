import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import { readFileSync, existsSync, mkdtempSync } from 'fs';
import { join } from 'path';
import os from 'os';
import { hardenWebviewPreferences, WEBVIEW_AUTOPLAY_POLICY } from '../../src/main/webview-prefs';
import { exitWatchdogScript } from '../../src/main/exit-watchdog';
import { rendererRecoveryCopy, isRecoverableGone } from '../../src/main/renderer-recovery';

const root = join(__dirname, '../..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

// ─── #287 — a video in the browser panel started playing, with sound, on load ──

describe('hardenWebviewPreferences (#287)', () => {
  it('applies Chrome\'s autoplay rule: media with sound waits for the user', () => {
    const prefs: Record<string, unknown> = {};
    hardenWebviewPreferences(prefs, {});
    expect(prefs.autoplayPolicy).toBe('document-user-activation-required');
    expect(WEBVIEW_AUTOPLAY_POLICY).toBe('document-user-activation-required');
  });

  it('still strips what a DOM attribute could have asked for', () => {
    const prefs: Record<string, unknown> = { preload: 'x.js', preloadURL: 'file:///x.js', nodeIntegration: true, contextIsolation: false };
    const params: Record<string, unknown> = { nodeintegration: 'true' };
    hardenWebviewPreferences(prefs, params);
    expect(prefs).not.toHaveProperty('preload');
    expect(prefs).not.toHaveProperty('preloadURL');
    expect(prefs.nodeIntegration).toBe(false);
    expect(prefs.contextIsolation).toBe(true);
    expect(params.nodeintegration).toBe('false');
  });

  it('is registered on the HOST window — the only contents will-attach-webview fires on', () => {
    // It used to be registered on `type === 'webview'` alone, i.e. on a guest,
    // where it never fires for a panel wmux draws.
    const index = read('src/main/index.ts');
    expect(index).toMatch(/if \(type === 'window' \|\| type === 'webview'\) \{\s*contents\.on\('will-attach-webview'/);
    expect(index).toMatch(/hardenWebviewPreferences\(/);
  });
});

// ─── #289 — main survived app.exit for 16 h ───────────────────────────────────

function runWatchdog(parentScript: string, deadlineMs: number, logPath: string) {
  return new Promise<{ parentCode: number | null; parentMs: number; watchdogMs: number }>((resolve) => {
    const t0 = Date.now();
    const parent = spawn(process.execPath, ['-e', parentScript], { stdio: 'ignore' });
    let parentCode: number | null = null;
    let parentMs = -1;
    parent.on('exit', (code) => { parentCode = code; parentMs = Date.now() - t0; });
    const wd = spawn(process.execPath, ['-e', exitWatchdogScript(parent.pid!, deadlineMs, logPath)], { stdio: 'ignore' });
    wd.on('exit', () => setTimeout(() => resolve({ parentCode, parentMs, watchdogMs: Date.now() - t0 }), 150));
  });
}

describe('exit watchdog (#289)', () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'wmux-wd-'));

  it('terminates a parent that outlives the deadline, and says so in main.log', async () => {
    const log = join(dir, 'hung.log');
    const r = await runWatchdog('setInterval(() => {}, 1000)', 800, log);
    expect(r.parentMs).toBeGreaterThanOrEqual(700);
    expect(r.parentCode).not.toBe(0);
    expect(readFileSync(log, 'utf8')).toMatch(/exit-watchdog killed=\d+/);
  }, 15_000);

  it('leaves on its own as soon as a healthy parent exits, killing nothing', async () => {
    const log = join(dir, 'clean.log');
    const r = await runWatchdog('setTimeout(() => {}, 200)', 10_000, log);
    expect(r.parentCode).toBe(0);
    expect(r.watchdogMs).toBeLessThan(3_000);
    expect(existsSync(log)).toBe(false);
  }, 15_000);

  it('is armed from will-quit, past the longest legitimate quit', () => {
    const index = read('src/main/index.ts');
    const willQuit = index.slice(index.indexOf("app.on('will-quit'"));
    expect(willQuit.slice(0, 1500)).toMatch(/armExitWatchdog\(\{/);
    expect(willQuit.slice(0, 1500)).toMatch(/deadlineMs: QUIT_TEARDOWN_BUDGET_MS \+ 15_000/);
  });

  it('runs as the app\'s own binary in Node mode, never through a shell script', () => {
    // Code lines only: the header comment explains why there is no shell script.
    const src = read('src/main/exit-watchdog.ts')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .join('\n');
    expect(src).toMatch(/ELECTRON_RUN_AS_NODE: '1'/);
    expect(src).not.toMatch(/cmd\.exe|powershell/i);
  });
});

describe('renderer recovery (#289)', () => {
  it('a hang offers Reload with Wait as the safe default', () => {
    const copy = rendererRecoveryCopy('unresponsive');
    expect(copy.buttons).toEqual(['Reload window', 'Wait']);
    expect(copy.detail).toMatch(/terminals are still running/);
  });

  it('a dead renderer offers Reload or Close', () => {
    expect(rendererRecoveryCopy('gone').buttons).toEqual(['Reload window', 'Close']);
  });

  it('a clean exit is not a failure', () => {
    expect(isRecoverableGone('clean-exit')).toBe(false);
    expect(isRecoverableGone('crashed')).toBe(true);
    expect(isRecoverableGone('oom')).toBe(true);
  });

  it('is wired to unresponsive/responsive/render-process-gone, and our own reload does not re-ask', () => {
    const wm = read('src/main/window-manager.ts');
    expect(wm).toMatch(/win\.on\('unresponsive'/);
    expect(wm).toMatch(/win\.on\('responsive'/);
    expect(wm).toMatch(/'render-process-gone'/);
    expect(wm).toMatch(/if \(reloading \|\| !isRecoverableGone/);
    expect(wm).toMatch(/defaultId: 1/);
  });
});
