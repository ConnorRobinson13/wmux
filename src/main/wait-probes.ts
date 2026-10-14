// The real `waitFor` probes behind workspace-scheduler.ts (#284). Bounded
// polls, nothing else: a TCP connect for `port`, a GET answered below 500 for
// `http`, a timer for `delay`. Loopback only — workspace-manifest.ts refuses
// any other host before a probe is ever built.

import * as net from 'net';
import * as http from 'http';
import * as https from 'https';
import type { WaitFor } from './workspace-manifest';

const POLL_MS = 500;
const ATTEMPT_MS = 2000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function portOpen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(ATTEMPT_MS, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

export function httpAnswers(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const lib = url.startsWith('https:') ? https : http;
    // A dev server's certificate is routinely self-signed, and this only asks
    // "is something answering on this machine" — no data is sent or trusted.
    const req = lib.get(url, { timeout: ATTEMPT_MS, rejectUnauthorized: false }, (res) => {
      res.resume();
      resolve((res.statusCode ?? 500) < 500);
    });
    req.once('timeout', () => { req.destroy(); resolve(false); });
    req.once('error', () => resolve(false));
  });
}

async function pollUntil(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await sleep(Math.min(POLL_MS, Math.max(0, deadline - Date.now())));
  }
  return false;
}

export async function waitFor(w: WaitFor): Promise<boolean> {
  if (w.kind === 'delay') {
    await sleep(w.ms);
    return true;
  }
  if (w.kind === 'port') return pollUntil(() => portOpen(w.host, w.port), w.timeoutMs);
  return pollUntil(() => httpAnswers(w.url), w.timeoutMs);
}

export { sleep };
