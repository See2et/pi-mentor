import assert from "node:assert/strict";
import type { Outcome, FailureKind } from "../src/domain/errors.ts";

export function expectOk<T>(result: Outcome<T>): T {
  assert.ok(result.isOk(), result.isErr() ? result.error.message : "Expected Ok");
  return result.value;
}
export function expectError(result: Outcome<unknown>, message: RegExp, kind?: FailureKind): void {
  assert.ok(result.isErr(), "Expected Err");
  assert.match(result.error.message, message);
  if (kind) assert.equal(result.error.kind, kind);
}
