import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { SessionFlushWaiters, SESSION_FLUSH_TIMEOUT_MS } from '../../src/main/session-flush';

// ─────────────────────────────────────────────────────────────────────────────
// Issue #285 — a startup command set on a pane was gone after a restart. Not a
// restore bug: session.json was written only on the 30 s auto-save tick and by
// a fire-and-forget broadcast in before-quit, and closing the LAST window with
// × reaches before-quit after that window is already gone. The reporter quit
// nine seconds after saving. The fix holds the close until the window's own
// `session:save` has landed, bounded so a hung renderer cannot block quitting.
// ─────────────────────────────────────────────────────────────────────────────

afterEach(() => { vi.useRealTimers(); });

describe('SessionFlushWaiters', () => {
  it('resolves true once that window\'s save has been written', async () => {
    const w = new SessionFlushWaiters();
    const p = w.wait(7);
    w.notifySaved(7);
    await expect(p).resolves.toBe(true);
    expect(w.pending(7)).toBe(0);
  });

  it('ignores a save from a different window', async () => {
    vi.useFakeTimers();
    const w = new SessionFlushWaiters();
    const p = w.wait(7, 500);
    w.notifySaved(8);
    expect(w.pending(7)).toBe(1);
    vi.advanceTimersByTime(500);
    await expect(p).resolves.toBe(false);
  });

  it('gives up after the deadline rather than holding the close forever', async () => {
    vi.useFakeTimers();
    const w = new SessionFlushWaiters();
    const p = w.wait(1);
    vi.advanceTimersByTime(SESSION_FLUSH_TIMEOUT_MS);
    await expect(p).resolves.toBe(false);
    expect(w.pending(1)).toBe(0);
  });

  it('a save after the deadline is harmless', async () => {
    vi.useFakeTimers();
    const w = new SessionFlushWaiters();
    const p = w.wait(1, 10);
    vi.advanceTimersByTime(10);
    w.notifySaved(1);
    await expect(p).resolves.toBe(false);
  });

  it('releases every waiter on the same window with one save', async () => {
    const w = new SessionFlushWaiters();
    const a = w.wait(3);
    const b = w.wait(3);
    w.notifySaved(3);
    await expect(Promise.all([a, b])).resolves.toEqual([true, true]);
  });

  it('keeps the timeout short — this runs on every quit', () => {
    expect(SESSION_FLUSH_TIMEOUT_MS).toBeLessThanOrEqual(2_000);
  });
});

describe('wiring (#285)', () => {
  const root = join(__dirname, '../..');
  const index = readFileSync(join(root, 'src/main/index.ts'), 'utf8');
  const wm = readFileSync(join(root, 'src/main/window-manager.ts'), 'utf8');
  const dialog = readFileSync(join(root, 'src/renderer/components/SplitPane/StartupCommandDialog.tsx'), 'utf8');

  it('the session:save listener releases the waiters', () => {
    expect(index).toMatch(/sessionFlush\.notifySaved\(event\.sender\.id\)/);
  });

  it('closing the last window waits for its state', () => {
    expect(index).toMatch(/windowManager\.beforeClose\s*=/);
    expect(wm).toMatch(/this\.flushBeforeClose\(entry, event\)/);
  });

  it('before-quit holds the quit for the flush instead of a fire-and-forget broadcast', () => {
    const body = index.slice(index.indexOf("app.on('before-quit'"));
    expect(body.slice(0, 1500)).toMatch(/event\.preventDefault\(\)/);
    expect(body.slice(0, 1500)).toMatch(/flushSessionFrom/);
  });

  it('saving a startup command writes session.json now', () => {
    expect(dialog).toMatch(/requestSessionSaveNow\(\)/);
  });
});
