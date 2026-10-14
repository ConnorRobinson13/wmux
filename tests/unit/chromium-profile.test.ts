import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  chromiumDataDir,
  migrateChromiumProfile,
  resolveUserDataDir,
  MIGRATION_MARKER,
} from '../../src/main/chromium-profile';

/**
 * #282: Electron's userData was %APPDATA%\wmux — also the default of
 * openwong2kim/wmux, a different app with the same name. Electron keys its
 * single-instance lock on userData, so the two could not run at once, and they
 * shared one Chromium profile. The profile now lives in a subdirectory, carried
 * over once by COPY.
 */

let root: string;
let appData: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-profile-'));
  appData = path.join(root, 'wmux');
  fs.mkdirSync(appData);
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(rel: string, content = 'x'): void {
  const file = path.join(appData, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** The shape a real wmux 2.21 data dir has: its own files beside Chromium's. */
function seedOldProfile(): void {
  write('Local Storage/leveldb/000003.log', 'prefs');
  write('Local Storage/leveldb/LOCK', '');
  write('Local Storage/leveldb/CURRENT', 'MANIFEST-000001');
  write('Network/Cookies', 'cookies');
  write('Local State', '{"os_crypt":{"encrypted_key":"k"}}');
  write('Preferences', '{}');
  write('IndexedDB/https_app.example_0.indexeddb.leveldb/000001.log', 'idb');
  write('Cache/Cache_Data/data_0', 'cache');
  write('lockfile', '');
  write('settings.json', '{"mine":true}');
  write('pipe-token', 'tok');
}

describe('chromiumDataDir', () => {
  it('is a subdirectory of wmux\'s own data dir, so it is a different lock', () => {
    expect(chromiumDataDir('C:\\Users\\u\\AppData\\Roaming\\wmux')).toBe(path.join('C:\\Users\\u\\AppData\\Roaming\\wmux', 'chromium'));
  });
});

describe('migrateChromiumProfile', () => {
  it('copies the state worth keeping, skips caches and lock files', () => {
    seedOldProfile();
    const target = chromiumDataDir(appData);
    const result = migrateChromiumProfile(appData, target);

    expect(result.status).toBe('migrated');
    expect(fs.readFileSync(path.join(target, 'Local Storage/leveldb/000003.log'), 'utf8')).toBe('prefs');
    expect(fs.readFileSync(path.join(target, 'Network/Cookies'), 'utf8')).toBe('cookies');
    // Cookies are useless without the key they are encrypted with.
    expect(fs.existsSync(path.join(target, 'Local State'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'IndexedDB/https_app.example_0.indexeddb.leveldb/000001.log'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'Cache'))).toBe(false);
    expect(fs.existsSync(path.join(target, 'Local Storage/leveldb/LOCK'))).toBe(false);
    expect(fs.existsSync(path.join(target, 'lockfile'))).toBe(false);
    expect(fs.existsSync(path.join(target, MIGRATION_MARKER))).toBe(true);
  });

  it('copies, never moves: the old profile is untouched for a downgrade or the other app', () => {
    seedOldProfile();
    migrateChromiumProfile(appData, chromiumDataDir(appData));
    expect(fs.readFileSync(path.join(appData, 'Local Storage/leveldb/000003.log'), 'utf8')).toBe('prefs');
    expect(fs.existsSync(path.join(appData, 'Network/Cookies'))).toBe(true);
  });

  it('leaves wmux\'s own files exactly where they are', () => {
    seedOldProfile();
    const target = chromiumDataDir(appData);
    migrateChromiumProfile(appData, target);
    expect(fs.existsSync(path.join(target, 'settings.json'))).toBe(false);
    expect(fs.existsSync(path.join(target, 'pipe-token'))).toBe(false);
    expect(fs.readFileSync(path.join(appData, 'settings.json'), 'utf8')).toBe('{"mine":true}');
  });

  it('runs once: a finished migration is not repeated over newer data', () => {
    seedOldProfile();
    const target = chromiumDataDir(appData);
    migrateChromiumProfile(appData, target);
    fs.writeFileSync(path.join(target, 'Local Storage/leveldb/000003.log'), 'newer');
    expect(migrateChromiumProfile(appData, target)).toEqual({ status: 'already' });
    expect(fs.readFileSync(path.join(target, 'Local Storage/leveldb/000003.log'), 'utf8')).toBe('newer');
  });

  it('a fresh install has nothing to carry and starts clean', () => {
    const target = chromiumDataDir(appData);
    expect(migrateChromiumProfile(appData, target)).toEqual({ status: 'fresh' });
    expect(fs.existsSync(path.join(target, MIGRATION_MARKER))).toBe(true);
  });

  it('a Local Storage that cannot be read fails WITHOUT a marker, and leaves no half copy', () => {
    seedOldProfile();
    const target = chromiumDataDir(appData);
    // What a file held open by a running profile does to a copy on Windows.
    const busy = (from: string, to: string) => {
      if (from.endsWith('000003.log')) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      fs.copyFileSync(from, to);
    };
    const result = migrateChromiumProfile(appData, target, busy);

    expect(result.status).toBe('failed');
    expect(fs.existsSync(path.join(target, MIGRATION_MARKER))).toBe(false);
    expect(fs.existsSync(path.join(target, 'Local Storage'))).toBe(false);
    // And the next launch tries again, from scratch.
    expect(migrateChromiumProfile(appData, target).status).toBe('migrated');
  });

  it('a non-critical entry that cannot be copied does not hold the migration back', () => {
    seedOldProfile();
    const target = chromiumDataDir(appData);
    const busy = (from: string, to: string) => {
      if (from.endsWith('Cookies')) throw new Error('EBUSY');
      fs.copyFileSync(from, to);
    };
    expect(migrateChromiumProfile(appData, target, busy).status).toBe('migrated');
  });
});

describe('resolveUserDataDir', () => {
  it('uses the new directory once the profile is there', () => {
    seedOldProfile();
    expect(resolveUserDataDir(appData).dir).toBe(chromiumDataDir(appData));
  });

  it('keeps the OLD directory for this launch when the copy failed — never a profile without the settings', () => {
    const failed = () => ({ status: 'failed' as const, error: 'EBUSY' });
    expect(resolveUserDataDir(appData, failed).dir).toBe(appData);
  });
});
