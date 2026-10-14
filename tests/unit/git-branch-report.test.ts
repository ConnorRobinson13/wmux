import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

/**
 * The git branch report is one spawn per prompt, not two.
 *
 * Both shell integrations used to run `git rev-parse --abbrev-ref HEAD` and
 * then `git status --porcelain` on every Enter — 49 ms of a 55 ms PowerShell
 * prompt, measured. `git status --porcelain=v2 --branch` carries both facts,
 * and this file pins the translation from its output back to the wire tokens
 * the old pair produced, so the sidebar never changes meaning:
 *
 *   - `# branch.head (detached)` is the `HEAD` rev-parse printed.
 *   - `# branch.oid (initial)` — an unborn repo — CLEARS, the way rev-parse's
 *     exit 128 did. v2 exits 0 there and names a branch that has no commit.
 *   - Untracked files count as dirty (no -uno), exactly as before.
 *   - The clean report keeps its trailing space: `report_git_branch <id> <b> `.
 *
 * The PowerShell decision is a pure function fed captured text; the bash one
 * is exercised by sourcing the real script with `git` replaced by a function.
 * Neither needs a repo.
 */

const PS1 = path.join(__dirname, '..', '..', 'src', 'shell-integration', 'wmux-powershell-integration.ps1');
const SH = path.join(__dirname, '..', '..', 'src', 'shell-integration', 'wmux-bash-integration.sh');
const psSource = fs.readFileSync(PS1, 'utf8').replace(/\r\n/g, '\n');
const shSource = fs.readFileSync(SH, 'utf8').replace(/\r\n/g, '\n');

const SURFACE = 'surf-2222';

// The v2 shapes git actually prints, captured from real repos.
const V2 = {
  clean: ['# branch.oid 2b6f0d3', '# branch.head main'],
  cleanTracking: ['# branch.oid 2b6f0d3', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +0 -0'],
  untracked: ['# branch.oid 2b6f0d3', '# branch.head main', '? untracked.txt'],
  modified: ['# branch.oid 2b6f0d3', '# branch.head main', '1 .M N... 100644 100644 100644 78981922 78981922 a.txt'],
  renamed: ['# branch.oid 2b6f0d3', '# branch.head main', '2 R. N... 100644 100644 100644 78981922 78981922 R100 b.txt\ta.txt'],
  unmerged: ['# branch.oid 2b6f0d3', '# branch.head main', 'u UU N... 100644 100644 100644 100644 1 2 3 4 a.txt'],
  detached: ['# branch.oid 2b6f0d3', '# branch.head (detached)'],
  unborn: ['# branch.oid (initial)', '# branch.head main'],
  unbornUntracked: ['# branch.oid (initial)', '# branch.head main', '? x.txt'],
  slashBranch: ['# branch.oid 2b6f0d3', '# branch.head perf/windows-latency'],
};

/** The per-case expectation, shared by both shells: same input, same wire text. */
const CASES: Array<[name: string, lines: string[], exit: number, wire: string]> = [
  ['clean', V2.clean, 0, `report_git_branch ${SURFACE} main `],
  ['clean with an upstream', V2.cleanTracking, 0, `report_git_branch ${SURFACE} main `],
  ['dirty by an untracked file', V2.untracked, 0, `report_git_branch ${SURFACE} main dirty`],
  ['dirty by a modified file', V2.modified, 0, `report_git_branch ${SURFACE} main dirty`],
  ['dirty by a rename', V2.renamed, 0, `report_git_branch ${SURFACE} main dirty`],
  ['dirty by a conflict', V2.unmerged, 0, `report_git_branch ${SURFACE} main dirty`],
  ['detached HEAD', V2.detached, 0, `report_git_branch ${SURFACE} HEAD `],
  ['a branch name with a slash', V2.slashBranch, 0, `report_git_branch ${SURFACE} perf/windows-latency `],
  ['unborn repo (git init, no commit)', V2.unborn, 0, `clear_git_branch ${SURFACE}`],
  ['unborn repo with an untracked file', V2.unbornUntracked, 0, `clear_git_branch ${SURFACE}`],
  ['outside any repo (exit 128)', [], 128, `clear_git_branch ${SURFACE}`],
  ['exit 0 with no branch header at all', ['? stray.txt'], 0, `clear_git_branch ${SURFACE}`],
];

// ---------------------------------------------------------------------------
// PowerShell
// ---------------------------------------------------------------------------

function extractFunction(name: string): string {
  const start = psSource.indexOf(`function ${name} {`);
  expect(start, `${name} is not defined in ${path.basename(PS1)}`).toBeGreaterThan(-1);
  const end = psSource.indexOf('\n}\n', start);
  expect(end, `${name} has no column-0 closing brace`).toBeGreaterThan(start);
  return psSource.slice(start, end + 2);
}

function findPowerShell(): string | null {
  for (const exe of ['pwsh.exe', 'powershell.exe', 'pwsh']) {
    try {
      execFileSync(exe, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { stdio: 'ignore' });
      return exe;
    } catch {
      // Not installed, or refused to run — try the next host.
    }
  }
  return null;
}

const host = findPowerShell();

function psBranchMessage(lines: string[], exitCode: number): string {
  const ps = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const array = lines.length ? `@(${lines.map(ps).join(', ')})` : '$null';
  const script = [
    extractFunction('Get-WmuxGitBranchMessage'),
    '',
    // Bracketed so a trailing space in the answer is visible to the assertion.
    `"[" + (Get-WmuxGitBranchMessage -SurfaceId ${ps(SURFACE)} -Lines ${array} -ExitCode ${exitCode}) + "]"`,
    '',
  ].join('\n');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-gitbranch-')), 'probe.ps1');
  fs.writeFileSync(file, script, 'utf8');
  try {
    return execFileSync(host as string, ['-NoProfile', '-NonInteractive', '-File', file], { encoding: 'utf8' }).trim();
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
}

describe.skipIf(!host)('Get-WmuxGitBranchMessage — one git spawn, the old wire tokens', () => {
  it.each(CASES)('%s', (_name, lines, exit, wire) => {
    expect(psBranchMessage(lines, exit)).toBe(`[${wire}]`);
  });
});

// ---------------------------------------------------------------------------
// PowerShell — the worker actually reaches the pipe (#279)
// ---------------------------------------------------------------------------

/**
 * Everything above tests what the worker would SAY. This tests that it is
 * heard. The worker runs in its own runspace, and a runspace has a session
 * state of its own — `$global:_wmux_pipe_name`, which Send-WmuxMessage
 * connects to, did not exist there, so from 2.9.0 every worker report opened
 * a pipe named $null and was swallowed by the catch. Only the first prompt
 * (synchronous, before the runspace opens) ever reached wmux, so the sidebar
 * showed the branch a pane STARTED in and never followed a `cd`.
 *
 * So: a real named pipe, the real script dot-sourced, the worker path forced
 * (the runspace waited open, `Request-WmuxGitReport` required to take the
 * cwd), and the report required to arrive.
 */
async function workerReports(shell: string, cwd: string): Promise<{ taken: string; messages: string[] }> {
  const net = await import('net');
  const { spawn } = await import('child_process');
  const instance = `gitworker${process.pid}-${process.hrtime.bigint()}`;
  const messages: string[] = [];
  const server = net.createServer((socket) => {
    let buf = '';
    socket.on('data', (d) => { buf += d.toString(); });
    socket.on('end', () => { messages.push(buf.trim()); });
    socket.on('error', () => {});
  });
  await new Promise<void>((resolve) => server.listen(`\\\\.\\pipe\\wmux-${instance}`, resolve));
  const ps = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const script = [
    `. ${ps(PS1)}`,
    // OpenAsync: wait for it, so the request below can only go to the worker.
    `$deadline = [DateTime]::UtcNow.AddSeconds(10)`,
    `while ($global:_wmux_git_runspace.RunspaceStateInfo.State -ne 'Opened' -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 20 }`,
    `Set-Location -LiteralPath ${ps(cwd)}`,
    `$taken = Request-WmuxGitReport -Cwd $ExecutionContext.SessionState.Path.CurrentFileSystemLocation.ProviderPath`,
    `[Console]::Out.Write("taken=$taken")`,
    `$deadline = [DateTime]::UtcNow.AddSeconds(10)`,
    `while ($global:_wmux_git_shared.running -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 20 }`,
  ].join('\n');
  try {
    const taken = await new Promise<string>((resolve, reject) => {
      const child = spawn(shell, ['-NoProfile', '-NonInteractive', '-Command', script], {
        env: { ...process.env, WMUX_INSTANCE: instance, WMUX_SURFACE_ID: SURFACE, WMUX_PIPE_TOKEN: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (d) => { out += d.toString(); });
      child.on('error', reject);
      child.on('exit', () => resolve(out.trim()));
    });
    // The last connection's 'end' can land just after the host exits.
    await new Promise((r) => setTimeout(r, 200));
    return { taken, messages: messages.filter((m) => /git_branch/.test(m)) };
  } finally {
    server.close();
  }
}

describe.skipIf(!host || process.platform !== 'win32')('the PowerShell git worker reaches wmux (#279)', () => {
  it('reports the branch from the worker runspace, not only from the synchronous path', async () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const { taken, messages } = await workerReports(host as string, repoRoot);
    expect(taken).toBe('taken=True');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(new RegExp(`^report_git_branch ${SURFACE} \\S+( dirty)?$`));
  }, 30_000);

  it('clears from the worker outside a repo', async () => {
    const { taken, messages } = await workerReports(host as string, os.tmpdir());
    expect(taken).toBe('taken=True');
    expect(messages).toEqual([`clear_git_branch ${SURFACE}`]);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// bash
// ---------------------------------------------------------------------------

function findBash(): string | null {
  // On Windows a bare `bash` is as likely to be WSL's launcher as Git's, and
  // WSL cannot source a script that lives on a Windows path the way this
  // one does — so only Git for Windows' own bash is accepted there.
  const candidates =
    process.platform === 'win32'
      ? [path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe')]
      : ['bash'];
  for (const exe of candidates) {
    try {
      execFileSync(exe, ['-c', 'exit 0'], { stdio: 'ignore' });
      return exe;
    } catch {
      // Not installed.
    }
  }
  return null;
}

const bash = findBash();

function shBranchMessage(lines: string[], exitCode: number): string {
  const sq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  // Git Bash takes a Windows path here; POSIX bash takes a POSIX one.
  const scriptPath = process.platform === 'win32' ? SH.replace(/\\/g, '/') : SH;
  const script = [
    // Sourced with no surface id, so the DEBUG trap the file installs has
    // nothing to report while the harness sets itself up; then the trap goes.
    `unset WMUX_SURFACE_ID`,
    `source ${sq(scriptPath)}`,
    `trap - DEBUG`,
    // The fake git insists on the argv the integration must send: without
    // --no-optional-locks a prompt-time status can leave index.lock in the way
    // of the `git commit` the user is typing.
    `git() {`,
    `  [ "$1" = --no-optional-locks ] && [ "$2" = status ] && [ "$3" = --porcelain=v2 ] && [ "$4" = --branch ] || { echo "unexpected git argv: $*" >&2; exit 99; }`,
    ...lines.map((l) => `  printf '%s\\n' ${sq(l)}`),
    `  return ${exitCode}`,
    `}`,
    `_wmux_report() { printf '[%s]\\n' "$1"; }`,
    `export WMUX_SURFACE_ID=${sq(SURFACE)}`,
    `_wmux_report_git`,
  ].join('\n');
  return execFileSync(bash as string, ['-c', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

describe.skipIf(!bash)('_wmux_report_git — one git spawn, the old wire tokens', () => {
  it.each(CASES)('%s', (_name, lines, exit, wire) => {
    expect(shBranchMessage(lines, exit)).toBe(`[${wire}]`);
  });
});

// ---------------------------------------------------------------------------
// The shape itself, read off the text
// ---------------------------------------------------------------------------

describe('the branch report spawns git once, and never takes the index lock', () => {
  it.each([
    ['PowerShell', psSource],
    ['bash', shSource],
  ])('%s no longer runs rev-parse --abbrev-ref HEAD followed by status --porcelain', (_shell, source) => {
    // Code only: both files explain the old two-spawn shape in a comment.
    const code = source
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    expect(code).not.toContain('rev-parse --abbrev-ref HEAD');
    expect(code).toContain('--no-optional-locks status --porcelain=v2 --branch');
  });

  it('PowerShell resolves git once at init, ahead of the Git\\cmd launcher', () => {
    // The launcher re-execs the real binary and costs ~8 ms per spawn doing
    // so — on a call made on every prompt.
    expect(psSource).toMatch(/\$global:_wmux_git = if \(Test-Path -LiteralPath "\$env:ProgramFiles\\Git\\mingw64\\bin\\git\.exe"/);
  });

  it('PowerShell hands the worker the FILESYSTEM location, not $PWD', () => {
    // `cd Env:` leaves $PWD.ProviderPath empty while git — started from this
    // thread — would still have answered for the last filesystem directory.
    expect(psSource).toContain('$ExecutionContext.SessionState.Path.CurrentFileSystemLocation.ProviderPath');
    expect(psSource).not.toMatch(/Request-WmuxGitReport -Cwd \$PWD\b/);
  });

  it('PowerShell disposes the worker runspace on the way out', () => {
    const exiting = psSource.indexOf('[System.Management.Automation.PSEngineEvent]::Exiting');
    expect(exiting).toBeGreaterThan(-1);
    const handler = psSource.slice(exiting, psSource.indexOf('\n}\n', exiting));
    expect(handler).toContain('Stop-WmuxGitWorker');
  });
});
