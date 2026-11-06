import { ok, safeTry } from "neverthrow";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { reject, type Outcome } from "./domain/errors.ts";
import type { Observation } from "./domain/work-unit.ts";
import { hostCall } from "./host.ts";

// Two matching read-only scans detect observable races, not an atomic filesystem snapshot.
export function observeSource(cwd: string): Observation {
  const checkedAt = new Date().toISOString();
  const observed = safeTry(function* () {
    const git = (args: string[], at = cwd) =>
      hostCall(() =>
        execFileSync("git", ["--no-optional-locks", "-C", at, ...args], {
          maxBuffer: 32 * 1024 * 1024,
          timeout: 5000,
          stdio: ["ignore", "pipe", "pipe"],
        }),
      );
    const root = (yield* git(["rev-parse", "--show-toplevel"])).toString().trim();
    const scan = (): Outcome<string> =>
      safeTry(function* () {
        const files = [
          ...new Set(
            (yield* git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], root))
              .toString()
              .split("\0")
              .filter(Boolean),
          ),
        ].sort();
        const hash = createHash("sha256");
        const add = (value: string | Buffer) => {
          const b = Buffer.from(value);
          hash.update(`${b.length}:`);
          hash.update(b);
        };
        add("mentor-source-v1");
        add(root);
        for (const file of files) {
          add(file);
          const path = join(root, file);
          const content = safeTry(function* () {
            const before = yield* hostCall(() => lstatSync(path, { bigint: true }));
            if (before.isSymbolicLink()) {
              add("symlink");
              add(yield* hostCall(() => readlinkSync(path)));
            } else if (before.isFile()) {
              add(String(before.mode & 0o111n));
              add(yield* hostCall(() => readFileSync(path)));
            } else
              return reject(`Unsupported directory/submodule/special source: ${file}`, "freshness");
            const after = yield* hostCall(() => lstatSync(path, { bigint: true }));
            if (
              before.ino !== after.ino ||
              before.size !== after.size ||
              before.mtimeNs !== after.mtimeNs ||
              before.ctimeNs !== after.ctimeNs
            )
              return reject(`Source changed during observation: ${file}`, "freshness");
            return ok(undefined);
          });
          if (
            content.isErr() &&
            (content.error.cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
          )
            add("deleted");
          else yield* content;
        }
        return ok(hash.digest("hex"));
      });
    const first = yield* scan();
    if ((yield* scan()) !== first)
      return reject("Source changed during observation; retry.", "freshness");
    return ok({ hash: first, root, checkedAt });
  });
  return observed.match(
    (source) => ({ source, checkedAt }),
    (failure) => ({ checkedAt, error: `Git source snapshot unavailable: ${failure.message}` }),
  );
}
