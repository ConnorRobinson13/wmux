import { describe, it, expect } from 'vitest';
import { execFile } from 'child_process';
import net from 'net';
import path from 'path';

/**
 * #282: openwong2kim/wmux — a different app with the same name — exports
 * `WMUX_SURFACE_ID` into its panes too, and this hook runs from the global
 * ~/.claude/settings.json in EVERY Claude session on the machine. So a Claude
 * session in one of its panes reported every tool call to this wmux, under a
 * surface id this wmux never issued.
 *
 * Run against the shipped resources/cli/wmux-hook.js over a real named pipe,
 * isolated with WMUX_INSTANCE so the test never talks to a live wmux.
 */

const HOOK_SCRIPT = path.resolve(__dirname, '../../resources/cli/wmux-hook.js');

/** Runs the hook against a private pipe; resolves with the frames it received. */
async function framesFor(
  envFor: Record<string, string> | ((pipe: string) => Record<string, string>),
): Promise<any[]> {
  const instance = `foreign${process.pid}-${process.hrtime.bigint()}`;
  const frames: any[] = [];
  const server = net.createServer((socket) => {
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk.toString();
      if (!data.includes('\n')) return;
      frames.push(JSON.parse(data.trim()));
      socket.end('{"id":1,"result":true}\n');
    });
    socket.on('error', () => {});
  });
  const pipe = `\\\\.\\pipe\\wmux-${instance}`;
  const env = typeof envFor === 'function' ? envFor(pipe) : envFor;
  await new Promise<void>((r) => server.listen(pipe, r));
  // A clean slate: nothing from the developer's own wmux pane may leak in.
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('WMUX')));
  try {
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        process.execPath,
        [HOOK_SCRIPT, '--event', 'PreToolUse', '--tool', 'Bash'],
        { env: { ...base, WMUX_INSTANCE: instance, WMUX_PIPE_TOKEN: 't', ...env } as Record<string, string>, timeout: 15000 },
        (err) => (err ? reject(err) : resolve()),
      );
      child.stdin?.end('{}');
    });
    await new Promise((r) => setTimeout(r, 100));
    return frames;
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

describe.skipIf(process.platform !== 'win32')('wmux-hook.js in another app\'s pane (#282)', () => {
  it('a surface id with none of our markers — another multiplexer\'s pane — is not reported', async () => {
    expect(await framesFor({ WMUX_SURFACE_ID: '7b1c9e0e-their-format' })).toEqual([]);
  });

  it('a pane this wmux spawned (WMUX=1) is reported, surface and all', async () => {
    const frames = await framesFor({ WMUX: '1', WMUX_SURFACE_ID: 'surf-ours' });
    expect(frames).toHaveLength(1);
    expect(frames[0].method).toBe('hook.event');
    expect(frames[0].params.surfaceId).toBe('surf-ours');
  });

  it('a WSL pane, where WMUX_PIPE is forwarded, is ours too', async () => {
    // WSLENV forwards WMUX_PIPE (and WMUX) into the distro; WMUX_PIPE alone
    // is enough to say the pane is ours.
    const frames = await framesFor((pipe) => ({ WMUX_SURFACE_ID: 'surf-wsl', WMUX_PIPE: pipe }));
    expect(frames).toHaveLength(1);
    expect(frames[0].params.surfaceId).toBe('surf-wsl');
  });

  it('a hook with no surface id at all behaves as before and is still sent', async () => {
    const frames = await framesFor({});
    expect(frames).toHaveLength(1);
    expect(frames[0].params.surfaceId).toBeUndefined();
  });
});
