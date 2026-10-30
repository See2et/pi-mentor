import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, unlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observeSource } from '../src/source.ts';

test('actual Git content snapshot includes tracked edits/deletions and untracked nonignored files, ignores external state and never commits', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mentor-source-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args]).toString();
  const hash = () => { const observed = observeSource(dir); assert.equal(observed.error, undefined); return observed.source!.hash; };
  try {
    git('init', '-q');
    writeFileSync(join(dir, '.gitignore'), 'ignored/\n');
    writeFileSync(join(dir, 'tracked.ts'), 'const n = 1;\n');
    git('add', '.gitignore', 'tracked.ts');
    const first = hash();
    assert.equal(hash(), first);
    mkdirSync(join(dir, 'ignored')); writeFileSync(join(dir, 'ignored/log'), 'ephemeral');
    assert.equal(hash(), first);
    writeFileSync(join(dir, 'tracked.ts'), 'const n = 2;\n');
    const edited = hash(); assert.notEqual(edited, first);
    writeFileSync(join(dir, 'new.ts'), 'new source');
    const untracked = hash(); assert.notEqual(untracked, edited);
    unlinkSync(join(dir, 'tracked.ts'));
    assert.notEqual(hash(), untracked);
    assert.match(git('status', '--porcelain'), /D tracked.ts/);
    assert.throws(() => git('rev-parse', '--verify', 'HEAD')); // No automatic commit, even an initial one.
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('non-Git source observation is explicitly unknown rather than invented freshness', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mentor-no-git-'));
  try { const o = observeSource(dir); assert.equal(o.source, undefined); assert.match(o.error!, /unavailable/); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});
