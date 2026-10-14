import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { isConsoleDefaultTitle } from '../../src/renderer/store/osc-title-slice';

// ─────────────────────────────────────────────────────────────────────────────
// Issue #286 — in an elevated wmux every pwsh tab was captioned
// "Administrator: C:\Program Files\WindowsApps\Microsoft.PowerShell_…\pwsh.exe".
// That is the console's DEFAULT title (exe path, localised admin prefix), which
// ConPTY forwards as OSC 0 and #221 then ranked above the cwd label.
// ─────────────────────────────────────────────────────────────────────────────

describe('isConsoleDefaultTitle', () => {
  it.each([
    'Administrator: C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe\\pwsh.exe',
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    'C:\\WINDOWS\\system32\\cmd.exe',
    'Administrator: C:\\WINDOWS\\system32\\cmd.exe',
    'Administrateur : C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    '管理员: C:\\Windows\\System32\\cmd.exe',
    '\\\\server\\share\\tools\\shell.exe',
    'pwsh.exe',
    'C:\\tools\\start.bat',
  ])('treats %s as the console default', (title) => {
    expect(isConsoleDefaultTitle(title)).toBe(true);
  });

  it.each([
    '✳ Claude Code',
    'vim README.md',
    'MINGW64:/c/Users/me/repo',
    'npm run dev',
    'codex — running',
    'ai-coding-crash-course',
    'Building C:\\repo\\app.exe',
    'L:\\repos\\ai\\ai-coding-crash-course',
    '',
  ])('keeps %s as a real title', (title) => {
    expect(isConsoleDefaultTitle(title)).toBe(false);
  });
});

describe('wiring (#286)', () => {
  const src = readFileSync(join(__dirname, '../../src/renderer/hooks/useTerminal.ts'), 'utf8');
  it('filters the default title only at the tab-label publish, not for detection', () => {
    expect(src).toMatch(/isConsoleDefaultTitle\(title\) \? '' : title/);
    expect(src).toMatch(/if \(normalized\) surfaceTitle\.set\(surfaceId, normalized\)/);
  });
});
