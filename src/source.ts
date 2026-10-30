import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Observation } from './units.ts';

// Read-only and synchronous: no await can separate source validation from a record commit.
// Two matching scans detect observable races; this is not an atomic filesystem snapshot.
export function observeSource(cwd: string): Observation {
  const checkedAt = new Date().toISOString();
  try {
    const git = (args: string[], at = cwd) => execFileSync('git', ['--no-optional-locks', '-C', at, ...args], { maxBuffer: 32 * 1024 * 1024, timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
    const root = git(['rev-parse', '--show-toplevel']).toString().trim();
    const scan = () => {
      const files = [...new Set(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], root).toString().split('\0').filter(Boolean))].sort();
      const hash = createHash('sha256');
      const add = (value: string | Buffer) => { const b = Buffer.from(value); hash.update(`${b.length}:`); hash.update(b); };
      add('mentor-source-v1'); add(root);
      for (const file of files) {
        add(file);
        const path = join(root, file);
        try {
          const before = lstatSync(path, { bigint: true });
          if (before.isSymbolicLink()) { add('symlink'); add(readlinkSync(path)); }
          else if (before.isFile()) { add(String(before.mode & 0o111n)); add(readFileSync(path)); }
          else throw new Error(`Unsupported directory/submodule/special source: ${file}`);
          const after = lstatSync(path, { bigint: true });
          if (before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error(`Source changed during observation: ${file}`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') add('deleted');
          else throw error;
        }
      }
      return hash.digest('hex');
    };
    const first = scan();
    if (scan() !== first) throw new Error('Source changed during observation; retry.');
    return { source: { hash: first, root, checkedAt }, checkedAt };
  } catch (error) {
    return { checkedAt, error: `Git source snapshot unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
}
