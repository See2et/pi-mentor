import { expectOk } from "../result.ts";
import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import mentorExtension from "../../index.ts";
import { currentJudgment } from "../../src/domain/design.ts";
import { initialState } from "../../src/domain/state.ts";
import { applyUser, applyModel } from "../../src/domain/workflow.ts";
import { location, mentorContext, GUIDANCE } from "../../src/presentation/record.ts";
import { unitJudgment, evidenceFreshness } from "../../src/domain/work-unit.ts";
import { defaultPiDefinitions, defaultPiToolNames, piLoadout, loadoutSize } from "./pi-loadout.ts";

type Handler = (...args: any[]) => any;
function dialogReady() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function harness(manager = SessionManager.inMemory(), cwd = process.cwd(), runtimeLoadout = false) {
  const events = new Map<string, Handler>();
  const tools: Map<string, any> = runtimeLoadout ? defaultPiDefinitions(cwd) : new Map();
  const commands = new Map<string, any>();
  const h = {
    manager,
    events,
    tools,
    commands,
    activeTools: runtimeLoadout
      ? [...defaultPiToolNames]
      : (["read", "unrelated_extension_tool"] as string[]),
    choices: [] as (string | undefined)[],
    edits: [] as (string | undefined)[],
    confirmations: [] as boolean[],
    notices: [] as string[],
    requests: [] as string[],
    menus: [] as { title: string; options: string[] }[],
    inspections: [] as string[][],
    cardResults: [] as string[],
    approvalBodies: [] as string[],
    inspectResults: [] as boolean[],
    inspector: undefined as (() => Promise<any>) | undefined,
    widget: undefined as Handler | undefined,
    appendFailure: undefined as Error | undefined,
    editor: undefined as (() => Promise<string | undefined>) | undefined,
    async emit(name: string, event: object = {}) {
      return events.get(name)!({ type: name, ...event }, h.ctx());
    },
    ctx(): ExtensionCommandContext {
      return {
        sessionManager: h.manager,
        cwd,
        mode: "tui",
        hasUI: true,
        isIdle: () => true,
        ui: {
          select: async (title: string, options: string[]) => {
            h.menus.push({ title, options });
            return h.choices.shift();
          },
          custom: async (factory: Handler) => {
            let result: unknown;
            let finish: ((value: unknown) => void) | undefined;
            const component = factory(
              { terminal: { rows: 28 }, requestRender() {} },
              { fg: (_t: string, x: string) => x, bg: (_t: string, x: string) => x },
              {},
              (value: unknown) => {
                result = value;
                finish?.(value);
              },
            );
            const screen: string[] = component.render(10000);
            if (screen.some((line) => line.startsWith("→ "))) {
              // Drive the real menu through keyboard input, including off-screen options.
              const options: string[] = [];
              for (;;) {
                const label = (component.render(10000) as string[])
                  .find((line) => line.startsWith("→ "))!
                  .slice(2);
                if (options.includes(label)) break;
                options.push(label);
                component.handleInput("k");
              }
              const confirmation = options.join("/") === "Yes/No";
              if (!confirmation) h.menus.push({ title: screen[0], options });
              const choice = confirmation
                ? h.confirmations.shift()
                  ? "Yes"
                  : "No"
                : h.choices.shift();
              if (choice === undefined) component.handleInput("\x1b");
              else {
                assert.ok(options.includes(choice), `Menu does not contain ${choice}: ${options}`);
                for (let n = 0; n < options.indexOf(choice); n++) component.handleInput("k");
                component.handleInput("\r");
              }
              return result;
            }
            h.inspections.push(component.render(36));
            if (screen[0].includes("Mentor · 承認待ち")) {
              component.handleInput("d");
              const pages: string[] = [];
              for (;;) {
                const page = component.render(10000).join("\n");
                if (pages.at(-1) === page) break;
                pages.push(page);
                component.handleInput("\x1b[6~");
              }
              h.approvalBodies.push(pages.join("\n"));
              component.handleInput("\r"); // Return without approving.
              return new Promise((resolve) => {
                finish = resolve;
                const drive = (choice: unknown) => {
                  if (choice === "edge") component.handleInput("k");
                  component.handleInput(choice === undefined ? "\x1b" : "\r");
                };
                if (h.inspector) void h.inspector().then(drive);
                else drive(h.cardResults.shift());
              });
            }
            return h.cardResults.length
              ? h.cardResults.shift()
              : h.inspector
                ? h.inspector()
                : (h.inspectResults.shift() ?? true);
          },
          editor: () => (h.editor ? h.editor() : Promise.resolve(h.edits.shift())),
          confirm: async () => h.confirmations.shift() ?? false,
          notify: (message: string) => h.notices.push(message),
          setWidget: (_key: string, factory: Handler) => {
            h.widget = factory;
          },
        },
      } as unknown as ExtensionCommandContext;
    },
    async command(args = "") {
      await commands.get("mentor").handler(args, h.ctx());
    },
    async status(query: object = { view: "full" }) {
      return (await tools.get("mentor_status").execute("s", query, undefined, undefined, h.ctx()))
        .details;
    },
    async record(action: object, expectedSnapshot?: string) {
      return tools
        .get("mentor_record")
        .execute(
          "r",
          { expectedSnapshot: expectedSnapshot ?? (await h.status()).snapshot, action },
          undefined,
          undefined,
          h.ctx(),
        );
    },
    async next(proposal: object, expectedSnapshot?: string) {
      assert.ok(tools.get("mentor_next"), "AI can prepare one next-action card without advancing");
      return tools
        .get("mentor_next")
        .execute(
          "n",
          { expectedSnapshot: expectedSnapshot ?? (await h.status()).snapshot, proposal },
          undefined,
          undefined,
          h.ctx(),
        );
    },
    async discuss(action: object, expectedSnapshot?: string) {
      assert.ok(tools.get("mentor_discuss"), "AI has a bounded discussion-only update surface");
      return tools
        .get("mentor_discuss")
        .execute(
          "d",
          { expectedSnapshot: expectedSnapshot ?? (await h.status()).snapshot, action },
          undefined,
          undefined,
          h.ctx(),
        );
    },
    async assist(
      proposal: object,
      options: {
        signal?: AbortSignal;
        ctx?: ExtensionCommandContext;
        expectedSnapshot?: string;
      } = {},
    ) {
      return tools
        .get("mentor_assist")
        .execute(
          "assist",
          { expectedSnapshot: options.expectedSnapshot ?? (await h.status()).snapshot, proposal },
          options.signal,
          undefined,
          options.ctx ?? h.ctx(),
        );
    },
    render(width: number): string[] {
      return h.widget!({}, { fg: (_token: string, text: string) => text }).render(width);
    },
  };
  const api = {
    on: (name: string, handler: Handler) => events.set(name, handler),
    registerCommand: (name: string, command: unknown) => commands.set(name, command),
    registerTool: (tool: any) => {
      tools.set(tool.name, tool);
      if (
        tool.defaultActive !== false &&
        ["direct", "model-only"].includes(tool.exposure ?? "direct")
      )
        h.activeTools.push(tool.name);
    },
    getActiveTools: () => [...h.activeTools],
    setActiveTools: (names: string[]) => {
      h.activeTools = runtimeLoadout
        ? piLoadout(tools, names).declared.map((t) => t.name)
        : [...names];
    },
    registerMessageRenderer() {},
    appendEntry: (kind: string, data: unknown) => {
      if (h.appendFailure) throw h.appendFailure;
      return h.manager.appendCustomEntry(kind, data);
    },
    sendMessage: (message: any) =>
      h.manager.appendCustomMessageEntry(
        message.customType,
        message.content,
        message.display,
        message.details,
      ),
    sendUserMessage: (text: string) => h.requests.push(text),
  } as unknown as ExtensionAPI;
  mentorExtension(api);
  return h;
}
test("next-card drafting is discoverable through codemode, while native approval is model-only", () => {
  const h = harness();
  assert.equal(h.tools.get("mentor_next").exposure, "codemode");
  assert.equal(h.tools.get("mentor_next").namespace.name, "mentor");
  assert.equal(h.tools.get("mentor_assist").exposure, "model-only");
});

test("record and status use discoverable codemode structured results; discussion remains direct", async () => {
  const h = harness();
  await h.emit("session_start");
  for (const name of ["mentor_record", "mentor_status", "mentor_next"]) {
    const tool = h.tools.get(name);
    assert.equal(tool.exposure, "codemode");
    assert.equal(tool.namespace.name, "mentor");
    assert.ok(tool.outputSchema, `${name} returns structured data to scripts`);
  }
  assert.equal(h.tools.get("mentor_discuss").exposure ?? "direct", "direct");
  const r = await h.tools.get("mentor_status").execute("s", {}, undefined, undefined, h.ctx());
  assert.deepEqual(r.structuredContent, JSON.parse(r.content[0].text));
});

test("mutations return deltas and recovery, not repeated record history", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.command("resume");
  const r = await h.record({ type: "proposal", text: "A proposal" });
  assert.equal(r.details.operationStatus, "recorded");
  assert.deepEqual(r.details.recorded, { type: "proposal", proposalId: 1 });
  assert.equal(r.details.record, undefined);
  assert.ok(r.details.snapshot);
  for (let n = 0; n < 8; n++) {
    const next = await h.record({
      type: "proposal",
      text: "Historical proposal content ".repeat(100),
    });
    assert.ok(
      JSON.stringify(next.details).length - JSON.stringify(r.details).length < 200,
      "mutation output stays independent of saved history",
    );
    assert.equal(next.details.record, undefined);
  }
  const failed = await h.record({ type: "proposal", text: "stale" }, "old");
  assert.equal(failed.isError, true);
  assert.equal(failed.details.record, undefined);
  assert.ok(failed.details.recovery.includes("mentor_status"));
});

test("status defaults to an explicit current projection and retrieves complete target histories", async () => {
  const h = await prepared();
  await h.record({ type: "draft", issueId: 1, text: "new unconfirmed target" });
  const current = await h.status({});
  assert.equal(current.view, "current");
  assert.ok(current.omitted.length);
  assert.ok(current.recovery.includes("issueId"));
  const target = await h.status({ view: "issue", issueId: 1 });
  assert.deepEqual(target.record.issue, (await h.status()).record.issues[0]);
  assert.equal(target.record.issue.revisions.length, 2);
  const before = h.manager.getEntries().length;
  for (const query of [
    { view: "issue" },
    { view: "unit" },
    { view: "issue", issueId: 99 },
    { view: "unit", unitId: 99 },
    { view: "current", issueId: 1 },
  ]) {
    const r = await h.tools.get("mentor_status").execute("s", query, undefined, undefined, h.ctx());
    assert.equal(r.isError, true);
    assert.ok(r.details.operationError);
  }
  await implementation(h);
  await h.record({ type: "unitReport", unitId: 1, revision: 1, text: "Observed limitations" });
  assert.deepEqual(
    (await h.status({ view: "unit", unitId: 1 })).record.unit,
    (await h.status()).record.units[0],
  );
  assert.ok(h.manager.getEntries().length > before);
});

test("registered declarations and enabled phase contexts stay within practical character budgets", (t) => {
  const h = harness();
  const declarations = Object.fromEntries(
    [...h.tools.values()].map((tool) => [
      tool.name,
      JSON.stringify({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }).length,
    ]),
  );
  for (const [name, limit] of Object.entries({
    mentor_next: 6100,
    mentor_assist: 6300,
    mentor_record: 5400,
    mentor_discuss: 1850,
    mentor_status: 1200,
  })) {
    assert.ok(declarations[name] < limit, `${name}: ${declarations[name]} chars`);
  }
  let s = expectOk(applyUser(initialState(), { type: "resume" }));
  const contexts: Record<string, number> = { initial: mentorContext(s)!.length };
  s = expectOk(applyUser(s, { type: "issue", text: "Input boundary" }));
  s = expectOk(applyUser(s, { type: "select", issueId: 1 }));
  s = expectOk(applyUser(s, { type: "phase", whole: "explore", inner: "critique" }));
  s = expectOk(
    applyUser(s, { type: "hypothesis", issueId: 1, text: "Validate input at boundary" }),
  );
  s = expectOk(
    applyModel(s, {
      type: "critique",
      issueId: 1,
      revision: 1,
      category: "security",
      text: "Unbounded input",
      evidence: "Parser receives user strings",
      status: "open",
    }),
  );
  contexts.populated = mentorContext(s)!.length;
  s = expectOk(
    applyUser(s, { type: "unitContract", contract: { ...unitContract, kind: "feature" } }),
  );
  s = expectOk(applyUser(s, { type: "selectUnit", unitId: 1 }));
  s = expectOk(applyUser(s, { type: "phase", whole: "implementation" }));
  for (const phase of ["scope", "implementing", "examination", "judgment"] as const) {
    s = expectOk(applyUser(s, { type: "unitPhase", unitId: 1, phase }));
    contexts[phase] = mentorContext(s)!.length;
    assert.ok(contexts[phase] < 10000, `${phase}: ${contexts[phase]} chars`);
  }
  assert.ok(contexts.initial < 6200);
  assert.ok(contexts.populated < 7500);
  console.info(JSON.stringify({ declarations, guidance: GUIDANCE.length, contexts }));
});

test("pause and restored sessions remove direct Mentor tools without changing unrelated selection", async () => {
  const h = harness();
  const direct = () => h.activeTools.filter((n) => n.startsWith("mentor_")).sort();
  assert.deepEqual(direct(), []);
  await h.emit("session_start");
  await h.command("resume");
  assert.deepEqual(direct(), ["mentor_assist", "mentor_discuss"]);
  h.activeTools = h.activeTools.filter((n) => n !== "read");
  h.activeTools.push("another_extension_tool", "mentor_record");
  const enabledManager = h.manager;
  await h.command("pause");
  assert.deepEqual(direct(), []);
  assert.deepEqual(h.activeTools, [
    "unrelated_extension_tool",
    "codemode",
    "another_extension_tool",
  ]);
  const pausedLeaf = h.manager.getLeafId()!;
  await h.emit("session_compact");
  await h.emit("session_tree");
  assert.deepEqual(direct(), []);
  assert.ok((await h.status({})).snapshot, "codemode status remains callable while paused");
  for (const call of [
    () => h.record({ type: "proposal", text: "No" }),
    () => h.discuss({ type: "direction" }),
    () => h.next({ summary: "No", unresolved: "", edge: { type: "review" } }),
  ])
    assert.equal((await call()).isError, true);
  await h.command("resume");
  assert.deepEqual(direct(), ["mentor_assist", "mentor_discuss"]);
  h.manager = SessionManager.inMemory();
  await h.emit("session_start");
  assert.deepEqual(direct(), []);
  h.manager = enabledManager;
  h.manager.branch(pausedLeaf);
  await h.emit("session_start");
  assert.deepEqual(direct(), []);
  await h.command("resume");
  assert.deepEqual(
    h.activeTools.filter((n) => !n.startsWith("mentor_")),
    ["unrelated_extension_tool", "codemode", "another_extension_tool"],
  );
});

test("generated Pi loadout budgets include codemode catalog and all exposed declarations", async (t) => {
  const h = harness(SessionManager.inMemory(), process.cwd(), true);
  const measurements: Record<string, ReturnType<typeof loadoutSize>> = {};
  for (const [phase, command] of [
    ["startup", undefined],
    ["enabled", "resume"],
    ["paused", "pause"],
  ] as const) {
    if (command) await h.command(command);
    else await h.emit("session_start");
    const loadout = piLoadout(h.tools, h.activeTools);
    const size = loadoutSize(loadout);
    measurements[phase] = size;
    const catalog = loadout.declared.find((tool) => tool.name === "codemode")?.description ?? "";
    assert.ok(
      catalog.includes("## mentor") && catalog.includes("mentor_status"),
      "measure the generated Mentor namespace, not the registration placeholder",
    );
    assert.ok(
      catalog.includes("expectedSnapshot") && catalog.includes("snapshot"),
      "generated catalog includes input/output declarations",
    );
    assert.ok(
      size.codemodeDescriptionChars > 1500 && size.codemodeDescriptionChars < 7500,
      `${phase} catalog: ${size.codemodeDescriptionChars} chars`,
    );
    assert.ok(
      size.declarationChars < (phase === "enabled" ? 19000 : 11000),
      `${phase} complete declaration set: ${size.declarationChars} chars`,
    );
  }
  console.info(
    JSON.stringify({
      fixture:
        "Pi 1.0.4 defaults; mode on, default 3000-estimated-token inline budget, models enabled, no MCP/other extensions; characters, not tokens",
      measurements,
    }),
  );
});

test("default Pi loadout exposes codemode to reach status through startup, pause and resume, never scripting approval", async () => {
  const h = harness(SessionManager.inMemory(), process.cwd(), true);
  assert.deepEqual(h.activeTools, defaultPiToolNames, "codemode is registered inactive by Pi");
  const checkReachability = async (enabled: boolean) => {
    const { declared, callable } = piLoadout(h.tools, h.activeTools);
    assert.ok(
      declared.some((tool) => tool.name === "codemode"),
      "model needs an active codemode entry point",
    );
    const status = callable.find((tool) => tool.name === "mentor_status");
    assert.ok(status, "registered status must be callable from the entry point");
    assert.equal(
      (await status.execute("nested-status", {}, undefined, undefined, h.ctx())).details.paused,
      !enabled,
    );
    assert.equal(
      callable.some((tool) => tool.name === "mentor_assist"),
      false,
      "model-only approval must never enter scripts",
    );
    assert.deepEqual(
      declared
        .filter((tool) => tool.name.startsWith("mentor_"))
        .map((tool) => tool.name)
        .sort(),
      enabled ? ["mentor_assist", "mentor_discuss"] : [],
    );
    for (const name of defaultPiToolNames) assert.ok(declared.some((tool) => tool.name === name));
  };
  await h.emit("session_start");
  await checkReachability(false);
  await h.command("resume");
  await checkReachability(true);
  await h.command("pause");
  await checkReachability(false);
  h.activeTools = h.activeTools.filter((name) => name !== "codemode");
  await h.emit("session_compact");
  await checkReachability(false);
  await h.command("resume");
  await checkReachability(true);
});

test("codemode container allows observed nested status but nested writes make source unknown and approvals stay blocked", async () => {
  const h = await stuck();
  await h.emit("tool_execution_start", { toolCallId: "code", toolName: "codemode" });
  assert.ok((await h.status({})).sourceObservation.source);
  assert.equal((await h.assist(repair)).isError, true);
  await h.emit("tool_execution_start", {
    toolCallId: "code/1",
    parentToolCallId: "code",
    toolName: "bash",
  });
  assert.equal((await h.status({})).sourceObservation.source, undefined);
  await h.emit("tool_execution_end", {
    toolCallId: "code/1",
    parentToolCallId: "code",
    toolName: "bash",
  });
  assert.ok((await h.status({})).sourceObservation.source);
  assert.equal((await h.record({ type: "proposal", text: "nested record" })).isError, undefined);
  await h.emit("tool_execution_end", { toolCallId: "code", toolName: "codemode" });
});

async function prepared() {
  const h = harness();
  await h.emit("session_start");
  await h.command("resume");
  h.edits.push("安全な入力を設計する");
  await h.command("goal");
  h.edits.push("既存APIを維持する");
  await h.command("constraints");
  h.edits.push("入力検証");
  await h.command("add");
  h.choices.push("#1 入力検証");
  await h.command("select");
  h.edits.push("境界で検証する");
  await h.command("hypothesis");
  assert.equal((await h.status()).record.issues[0].currentRevision, 1);
  return h;
}

test("cancelled menu, editor, nested phase and final judgment confirmation have no effects", async () => {
  const h = await prepared();
  const before = await h.status();
  const count = h.manager.getEntries().length;
  await h.command();
  await h.command("goal");
  h.choices.push("論点の検討", undefined);
  await h.command("phase");
  h.choices.push("暫定採用");
  h.edits.push("This should be cancelled");
  h.confirmations.push(false);
  await h.command("judge");
  assert.deepEqual((await h.status()).record, before.record);
  assert.equal(h.manager.getEntries().length, count);
  assert.equal(h.requests.length, 0);
});

test("menu and tools support grounded critique, human defense, AI retraction, exact human judgment and revision history", async () => {
  const h = await prepared();
  h.choices.push("論点の検討", "批判・弁護");
  await h.command("phase");
  let result = await h.record({
    type: "critique",
    issueId: 1,
    revision: 1,
    category: "security",
    text: "長さ制限がない",
    evidence: "無制限の文字列がパーサに届く場合",
    status: "open",
  });
  assert.equal(result.isError, undefined);
  h.choices.push("c1 [security] 長さ制限がない");
  h.edits.push("上流に上限がある。handler.ts:20");
  await h.command("response");
  result = await h.record({
    type: "critique",
    issueId: 1,
    revision: 1,
    category: "security",
    text: "上流制限の確認により撤回",
    evidence: "handler.ts:20 で上限が保証される条件",
    status: "withdrawn",
    replaces: 1,
  });
  assert.equal(result.isError, undefined);
  h.choices.push("暫定採用");
  h.edits.push("上流制限を維持する");
  h.confirmations.push(true);
  await h.command("judge");
  let state = (await h.status()).record;
  assert.equal(state.whole, "explore");
  assert.equal(state.issues[0].inner, "critique"); // judgment is not a transition
  assert.equal(state.issues[0].judgments[0].author, "human");
  assert.equal(state.issues[0].responses[0].author, "human");
  assert.equal(state.issues[0].critiques.length, 2);
  await h.record({ type: "draft", issueId: 1, text: "上流制限も契約にする" });
  assert.equal((await h.status()).record.issues[0].currentRevision, 1);
  h.choices.push("r2 上流制限も契約にする", "この正確な内容を本人の現在仮説として確認");
  h.confirmations.push(true);
  await h.command("draft");
  state = (await h.status()).record;
  assert.equal(state.issues[0].currentRevision, 2);
  assert.equal(state.issues[0].judgments[0].revision, 1);
  assert.equal(currentJudgment(state.issues[0]), undefined);
  assert.equal(h.requests.length, 0);
});

test("tools reject stale concurrent proposals; open dialogs cannot commit over model updates or session replacement", async () => {
  const h = await prepared();
  const old = (await h.status()).snapshot;
  await h.record({ type: "proposal", text: "整理を提案" }, old);
  const stale = await h.record({ type: "proposal", text: "古い並行呼出し" }, old);
  assert.equal(stale.isError, true);
  assert.equal((await h.status()).record.proposals.length, 1);
  let resolve!: (text: string) => void;
  let opened = dialogReady();
  h.editor = () =>
    new Promise((done) => {
      resolve = done;
      opened.resolve();
    });
  const open = h.command("goal");
  await opened.promise;
  await h.record({ type: "proposal", text: "開いたメニューの後の変更" });
  resolve("stale text");
  await open;
  assert.equal((await h.status()).record.goal, "安全な入力を設計する");
  assert.match(h.notices.at(-1)!, /state changed/);
  opened = dialogReady();
  const oldDialog = h.command("goal");
  await opened.promise;
  const oldManager = h.manager;
  h.manager = SessionManager.inMemory();
  await h.emit("session_start", { reason: "new" });
  resolve("wrong session");
  await oldDialog;
  assert.equal((await h.status()).record.goal, "");
  assert.equal(oldManager.getBranch().at(-1)?.type, "custom");
  assert.equal(h.manager.getEntries().length, 0);
});

test("hints queue one native user request without state change; paused normal chat has no injected guidance", async () => {
  const h = await prepared();
  const before = await h.status();
  h.choices.push("部分案");
  await h.command("hint");
  assert.deepEqual((await h.status()).record, before.record);
  assert.equal(h.requests.length, 1);
  assert.match(h.requests[0], /this response only/);
  await h.command("pause");
  const paused = await h.status();
  assert.equal((await h.record({ type: "proposal", text: "禁止" })).isError, true);
  const context = await h.emit("context", { messages: [] });
  assert.deepEqual(context.messages, []);
  await h.command("hint");
  assert.deepEqual((await h.status()).record, paused.record);
  assert.equal(h.requests.length, 1);
  assert.ok(h.render(32).join("\n").includes("一時停止"));
  await h.command("resume");
  assert.ok(
    (await h.emit("context", { messages: [] })).messages[0].content.includes("CURRENT LOCATION"),
  );
});

test("active branch restoration excludes abandoned data and keeps widget and context aligned after compaction/reload", async () => {
  const h = await prepared();
  const base = h.manager.getLeafId()!;
  h.choices.push("まとめ");
  await h.command("phase");
  const future = h.manager.getLeafId()!;
  h.manager.branch(base);
  await h.emit("session_tree");
  assert.ok(h.manager.getEntries().some((e) => e.id === future));
  assert.equal((await h.status()).record.whole, "goals");
  await h.emit("session_compact");
  await h.emit("session_start", { reason: "reload" });
  const status = await h.status();
  const context = (
    await h.emit("context", {
      messages: [{ role: "custom", customType: "mentor-display", content: "old view" }],
    })
  ).messages;
  assert.equal(context.length, 1);
  for (const line of location(status.record)) assert.ok(context[0].content.includes(line));
  assert.ok(h.render(100).join("\n").includes("目標・制約の相談 → 論点の整理"));
  for (const width of [16, 32, 80, 120]) {
    for (const line of h.render(width)) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
    assert.ok(
      !h.render(width).join("\n").includes("r1"),
      "normal widget does not expose internal revision management",
    );
  }
});

test("malformed persistence is read-only until an explicit confirmed reset", async () => {
  const h = await prepared();
  h.manager.appendCustomEntry("mentor-state", { schema: 99 });
  await h.emit("session_start", { reason: "reload" });
  assert.match((await h.status()).error, /invalid or unsupported/);
  const count = h.manager.getEntries().length;
  await h.command("resume");
  await h.record({ type: "proposal", text: "must fail" });
  assert.equal(h.manager.getEntries().length, count);
  h.confirmations.push(false);
  await h.command("reset");
  assert.equal(h.manager.getEntries().length, count);
  h.confirmations.push(true);
  await h.command("reset");
  assert.equal((await h.status()).error, undefined);
  assert.equal((await h.status()).record.enabled, false);
});

test("Pi session entries survive disk reopening once Pi has a real conversation; active branch is restored", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-mentor-test-"));
  try {
    const manager = SessionManager.create(process.cwd(), dir);
    // This is a session fixture, not inference. Pi does not flush setup-only sessions.
    manager.appendMessage({ role: "user", content: "Session fixture", timestamp: Date.now() });
    const h = harness(manager);
    await h.emit("session_start");
    await h.command("resume");
    h.edits.push("Persisted goal");
    await h.command("goal");
    const base = manager.getLeafId()!;
    h.choices.push("まとめ");
    await h.command("phase");
    manager.branch(base);
    manager.appendCustomEntry("branch-marker", {});
    h.manager = SessionManager.open(manager.getSessionFile()!);
    await h.emit("session_start", { reason: "resume" });
    const state = (await h.status()).record;
    assert.equal(state.goal, "Persisted goal");
    assert.equal(state.whole, "goals");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ordinary discussion switches modes only by selection and starts an exact contract with one native approval", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.command("resume");
  for (const action of [
    { type: "goals", goal: "安全な入力", constraints: "API維持" },
    { type: "issue", text: "入力検証" },
    { type: "target", text: "境界で長さを制限する" },
  ])
    assert.equal((await h.discuss(action)).isError, undefined);
  let s = (await h.status()).record;
  assert.equal(s.discussion.mode, "hypothesis");
  assert.equal(s.issues[0].revisions[0].confirmed, false);
  assert.equal((await h.discuss({ type: "direction" })).isError, true);
  const mode = {
    summary: "批判・弁護を提案",
    unresolved: "入力長は未確認",
    edge: { type: "critique" },
  };
  assert.equal((await h.next(mode)).details.operationStatus, "proposed");
  assert.equal((await h.status()).record.discussion.mode, "hypothesis");
  await h.emit("input", { source: "interactive", text: "批判・弁護に切り替える確認を出して" });
  h.cardResults.push("continue");
  assert.equal((await h.assist(mode)).details.operationStatus, "cancelled");
  assert.equal((await h.status()).record.discussion.mode, "hypothesis");
  assert.equal(
    (await h.assist(mode)).details.operationStatus,
    "rejected",
    "cannot retry on declined input",
  );
  await h.emit("input", { source: "interactive", text: "切り替えの確認をもう一度" });
  h.cardResults.push("edge");
  assert.equal((await h.assist(mode)).details.operationStatus, "applied");
  await h.record({
    type: "critique",
    issueId: 1,
    revision: 1,
    category: "uncertainty",
    text: "上限の根拠",
    evidence: "想定入力長が未知",
    status: "open",
  });
  await h.discuss({ type: "target", text: "利用者が挙げた別の仮説" });
  await h.discuss({ type: "issue", text: "関連する入力の形式" });
  assert.equal((await h.status()).record.discussion.mode, "critique");
  assert.equal((await h.discuss({ type: "rethink" })).isError, true);
  const formation = { summary: "仮説を考え直す", unresolved: "", edge: { type: "hypothesis" } };
  h.inspector = async () => {
    await h.record({ type: "proposal", text: "承認中に記録が変化" });
    return "edge";
  };
  assert.equal(
    (await h.assist(formation)).details.operationStatus,
    "rejected",
    "stale mode approval applies nothing",
  );
  h.inspector = undefined;
  assert.equal((await h.status()).record.discussion.mode, "critique");
  await h.emit("input", { source: "interactive", text: "仮説形成への確認をもう一度" });
  h.cardResults.push("edge");
  assert.equal((await h.assist(formation)).details.operationStatus, "applied");
  assert.equal((await h.status()).record.discussion.mode, "hypothesis");
  await h.emit("input", { source: "interactive", text: "この正確な範囲で始める確認を出して" });
  const count = h.manager.getEntries().length;
  const approvals = h.approvalBodies.length;
  h.cardResults.push("edge");
  assert.equal(
    (
      await h.assist({
        summary: "範囲を限定して開始",
        unresolved: "入力長は未確認",
        edge: { type: "start", contract: unitContract },
      })
    ).details.operationStatus,
    "applied",
  );
  s = (await h.status()).record;
  assert.equal(h.manager.getEntries().length, count + 1);
  assert.equal(h.approvalBodies.length, approvals + 1, "no adopt/scope/start approval chain");
  assert.equal(s.units[0].phase, "implementing");
  assert.deepEqual(s.units[0].revisions[0].contract, unitContract);
  assert.equal(s.issues[0].judgments.length, 0);
  for (const text of [
    unitContract.scope,
    unitContract.nonGoals,
    unitContract.verificationPlan,
    unitContract.expectations[0].text,
  ])
    assert.ok(h.approvalBodies.at(-1)!.includes(text));
  await h.emit("session_start");
  assert.deepEqual(
    (await h.status()).record,
    s,
    "multi-target discussion and one-approval start restore",
  );
});

test("discussion updates cannot skip stages, judge, confirm scope or revive prior adoption", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.command("resume");
  const untouched = (await h.status()).record;
  for (const action of [
    { type: "direction" },
    { type: "target", text: "案" },
    { type: "issue", text: "論点" },
    { type: "adopt" },
    { type: "phase", whole: "implementation" },
    { type: "confirmDraft", issueId: 1, revision: 1 },
    { type: "confirmUnit", unitId: 1, revision: 1 },
    { type: "start" },
    { type: "accept" },
    { type: "switchUnit", unitId: 1 },
    { type: "goals", goal: "目標", constraints: "", decision: "adopt" },
  ]) {
    assert.equal((await h.discuss(action)).isError, true);
    assert.deepEqual((await h.status()).record, untouched);
  }
  await h.discuss({ type: "goals", goal: "目標", constraints: "" });
  await h.discuss({ type: "issue", text: "論点" });
  assert.equal((await h.discuss({ type: "direction" })).isError, true);
  await h.discuss({ type: "target", text: "案1" });
  await h.emit("input", { source: "interactive", text: "批判・弁護へ" });
  h.cardResults.push("edge");
  await h.assist({ summary: "切り替える", unresolved: "", edge: { type: "critique" } });
  h.cardResults.push("edge");
  await h.assist({ summary: "旧来の採否相談", unresolved: "", edge: { type: "decide" } });
  await h.emit("input", { source: "interactive", text: "採用を確認したい" });
  h.cardResults.push("edge");
  await h.assist({ summary: "採用", unresolved: "", edge: { type: "adopt", note: "" } });
  const adopted = (await h.status()).record;
  assert.equal(
    (await h.discuss({ type: "target", text: "案2" })).isError,
    true,
    "discussion cannot leave scope or switch units",
  );
  assert.deepEqual((await h.status()).record, adopted);
  h.cardResults.push("edge");
  await h.assist({ summary: "設計を見直す", unresolved: "", edge: { type: "design", note: "" } });
  await h.discuss({ type: "target", text: "案2" });
  await h.discuss({ type: "target", text: "案1" });
  let s = (await h.status()).record;
  assert.equal(
    s.issues[0].currentRevision,
    3,
    "same text never switches back to the adopted old revision",
  );
  assert.equal(s.issues[0].revisions[2].confirmed, false);
  assert.equal(currentJudgment(s.issues[0]), undefined);
  assert.equal(s.issues[0].judgments.length, 1);
  await h.emit("session_start");
  assert.deepEqual(
    (await h.status()).record,
    s,
    "current unconfirmed target restores without reinterpreting confirmations",
  );
  const stale = (await h.status()).snapshot;
  await h.record({ type: "proposal", text: "別記録" });
  assert.equal((await h.discuss({ type: "direction" }, stale)).isError, true);
  await h.command("pause");
  s = (await h.status()).record;
  assert.equal((await h.discuss({ type: "direction" })).isError, true);
  assert.deepEqual((await h.status()).record, s);
});

test("editor widget is one phase-to-phase line, never candidate content; exceptions take priority", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.command("resume");
  await h.next({
    summary: "候補には長い文章や改行\nがある",
    unresolved: "未解決の長文",
    edge: { type: "goals", goal: "目標", constraints: "" },
  });
  for (const width of [1, 4, 12, 24, 80, 120]) {
    const lines = h.render(width);
    assert.equal(lines.length, 1);
    assert.ok(visibleWidth(lines[0]) <= width);
    assert.doesNotMatch(lines[0], /候補|未解決|この目標/);
  }
  assert.match(h.render(80)[0], /目標.*→.*論点/);
  assert.deepEqual(h.render(0), []);
  await h.command("pause");
  assert.match(h.render(80)[0], /一時停止/);
  assert.doesNotMatch(h.render(80)[0], /→/);
  h.manager.appendCustomEntry("mentor-state", { schema: 99 });
  await h.emit("session_start");
  assert.match(h.render(80)[0], /保存エラー/);
});

const unitContract = {
  kind: "feature",
  title: "入力境界",
  purpose: "入力を守る",
  designRefs: ["仕様 input-v1"],
  scope: "入力ハンドラ",
  expectations: [{ id: "E1", text: "過大入力を拒否" }],
  nonGoals: "UI",
  verificationPlan: "実入力を送る",
};
async function implementation(h: ReturnType<typeof harness>) {
  await h.emit("session_start");
  await h.command("resume");
  h.choices.push("実装・検証");
  await h.command("phase");
  await h.record({ type: "unitDraft", contract: unitContract });
  h.choices.push("U1 入力境界");
  await h.command("units");
  h.choices.push("契約 v1 入力境界");
  h.confirmations.push(true);
  await h.command("unit-draft");
  h.confirmations.push(true);
  await h.command("unit-go:implementing");
}

test("native menu boundary supports human unit creation/exact confirmation, evidence, optional notes and judgment without advancing next unit", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.command("resume");
  h.choices.push("実装・検証");
  await h.command("phase");
  h.choices.push("機能実装");
  h.edits.push(
    "入力境界",
    "入力を守る",
    "仕様 input-v1",
    "入力ハンドラ",
    "E1: 過大入力を拒否",
    "UI",
    "実入力を送る",
  );
  h.confirmations.push(true);
  await h.command("unitNew");
  let status = await h.status();
  assert.deepEqual(status.record.units[0].revisions[0].contract, unitContract);
  assert.equal(status.record.activeUnit, null);
  h.choices.push("U1 入力境界");
  await h.command("units");
  h.confirmations.push(false);
  await h.command("unit-go:implementing");
  assert.equal((await h.status()).record.units[0].phase, "scope");
  h.confirmations.push(true);
  await h.command("unit-go:implementing");
  status = await h.status();
  assert.equal(status.record.units[0].phase, "implementing");
  const result = await h.record({
    type: "unitEvidence",
    unitId: 1,
    revision: 1,
    sourceHash: status.sourceObservation.source.hash,
    entries: [
      {
        expectationId: "E1",
        observation: "過大入力の拒否を観測",
        references: ["node check-input.ts; exit 0; response 400"],
        method: "real",
        limitations: "本番サービス未確認",
      },
    ],
    concerns: "本番条件は未知",
  });
  assert.equal(result.isError, undefined);
  await h.command("unit-go:examination");
  h.edits.push("境界値を自分でも確認する");
  await h.command("note");
  await h.command("evidence");
  await h.command("unit-go:judgment");
  h.choices.push("このスコープを受け入れる");
  h.edits.push("本番は未確認のまま受け入れる");
  h.confirmations.push(true);
  await h.command("unit-judge");
  status = await h.status();
  assert.equal(status.record.units[0].judgments[0].decision, "accept");
  assert.equal(status.record.units[0].phase, "judgment");
  assert.equal(status.record.activeUnit, 1);
  assert.equal(status.record.units[0].notes[0].author, "human");
  assert.equal(h.requests.length, 0);
  const selection = h.menus.find((m) => m.options.includes("U1 入力境界"))!;
  assert.equal(selection.options[0], "戻る（変更なし）");
  await h.record({
    type: "unitDraft",
    unitId: 1,
    contract: { ...unitContract, scope: "改訂の提案" },
  });
  const beforeDraft = (await h.status()).record;
  h.choices.push("契約 v2 入力境界");
  h.confirmations.push(false);
  await h.command("unit-draft");
  assert.deepEqual((await h.status()).record, beforeDraft);
  assert.equal(h.menus.at(-1)!.options[0], "戻る（変更なし）");
  for (const width of [16, 36, 100])
    for (const line of h.render(width)) assert.ok(visibleWidth(line) <= width);
  for (const screen of h.inspections) {
    assert.ok(screen.length <= 27);
    for (const line of screen) assert.ok(visibleWidth(line) <= 36);
  }
});

test("actual source changes invalidate evidence/acceptance, reject stale model snapshots and open judgment dialogs; tool activity exposes unknown freshness", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mentor-integration-"));
  try {
    execFileSync("git", ["-C", dir, "init", "-q"]);
    writeFileSync(join(dir, "source.ts"), "original");
    execFileSync("git", ["-C", dir, "add", "source.ts"]);
    const h = harness(SessionManager.inMemory(), dir);
    await implementation(h);
    let status = await h.status();
    const evidence = {
      type: "unitEvidence",
      unitId: 1,
      revision: 1,
      sourceHash: status.sourceObservation.source.hash,
      entries: [
        {
          expectationId: "E1",
          observation: "入力を拒否した",
          references: ["check.ts:5"],
          method: "substitute",
          limitations: "fake APIのみ",
        },
      ],
      concerns: "実API未検証",
    };
    assert.equal((await h.record(evidence)).isError, undefined);
    await h.command("unit-go:judgment");
    h.choices.push("このスコープを受け入れる");
    h.edits.push("代替対象だけで受け入れる");
    h.confirmations.push(true);
    await h.command("unit-judge");
    status = await h.status();
    assert.equal(
      unitJudgment(status.record.units[0], status.sourceObservation)?.decision,
      "accept",
    );
    const priorSnapshot = status.snapshot;
    writeFileSync(join(dir, "new.ts"), "untracked source change");
    status = await h.status();
    assert.equal(unitJudgment(status.record.units[0], status.sourceObservation), undefined);
    assert.match(evidenceFreshness(status.record.units[0], status.sourceObservation), /古い/);
    assert.equal((await h.record(evidence, priorSnapshot)).isError, true);
    let resolve!: (ok: boolean) => void;
    const opened = dialogReady();
    h.inspector = () =>
      new Promise((done) => {
        resolve = done;
        opened.resolve();
      });
    const dialog = h.command("unit-judge");
    await opened.promise;
    unlinkSync(join(dir, "source.ts"));
    resolve(true);
    await dialog;
    assert.match(h.notices.at(-1)!, /state changed/);
    assert.equal((await h.status()).record.units[0].judgments.length, 1);
    h.inspector = undefined;
    await h.emit("tool_execution_start", { toolCallId: "write-1", toolName: "bash" });
    status = await h.status();
    assert.equal(status.sourceObservation.source, undefined);
    assert.match(h.render(100).join("\n"), /鮮度不明/);
    assert.equal((await h.record(evidence)).isError, true);
    await h.emit("tool_execution_end", { toolCallId: "write-1", toolName: "bash" });
    status = await h.status();
    assert.ok(status.sourceObservation.source);
    const context = await h.emit("context", { messages: [] });
    for (const line of location(status.record, status.sourceObservation))
      assert.ok(context.messages[0].content.includes(line));
    const base = h.manager.getLeafId()!;
    h.choices.push("修正を依頼する");
    h.edits.push("実APIを確認したい");
    h.confirmations.push(true);
    await h.command("unit-judge");
    h.manager.branch(base);
    await h.emit("session_tree");
    assert.equal((await h.status()).record.units[0].judgments.length, 1);
    await h.command("pause");
    assert.equal((await h.emit("context", { messages: [] })).messages.length, 0);
    assert.equal(
      (await h.record({ type: "unitReport", unitId: 1, revision: 1, text: "準備完了" })).isError,
      true,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("guided card prepares without authority; one chosen edge bundles exact records and progress", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.command("resume");
  const offer = async (edge: object) => {
    const before = (await h.status()).record;
    const result = await h.next({
      summary: "会話から整理した候補",
      unresolved: "実環境の挙動は未確認",
      edge,
    });
    assert.equal(result.isError, undefined, JSON.stringify(result.details));
    const after = (await h.status()).record;
    assert.equal(after.whole, before.whole);
    assert.equal(after.activeIssue, before.activeIssue);
    assert.deepEqual(after.issues, before.issues);
    assert.deepEqual(after.units, before.units);
    const count = h.manager.getEntries().length;
    h.cardResults.push("edge");
    await h.command();
    assert.equal(h.manager.getEntries().length, count + 1, "one atomic state entry per edge");
    assert.match(
      h.notices.at(-1)!,
      /適用しました:/,
      "normal card reports the actual applied action without another confirmation",
    );
    assert.equal(h.requests.length, 0, "choosing an edge does not force inference");
  };
  await offer({ type: "goals", goal: "安全な入力を設計する", constraints: "API維持" });
  await offer({ type: "issue", text: "入力検証" });
  assert.equal((await h.status()).record.issues[0].currentRevision, null);
  await offer({ type: "critique", text: "境界で入力を検証する" });
  let s = (await h.status()).record;
  assert.equal(s.issues[0].inner, "critique");
  assert.equal(s.issues[0].revisions[0].text, "境界で入力を検証する");
  assert.equal(s.issues[0].judgments.length, 0, "review target is not adoption");
  await offer({ type: "decide" });
  await offer({ type: "adopt", note: "境界を明示する" });
  s = (await h.status()).record;
  assert.equal(s.issues[0].judgments[0].decision, "adopt");
  assert.equal(s.whole, "implementation");
  assert.equal(s.units.length, 0, "direction is not implementation authorization");
  await offer({ type: "start", contract: unitContract });
  s = (await h.status()).record;
  assert.equal(s.units[0].phase, "implementing");
  assert.deepEqual(s.units[0].revisions[0].contract, unitContract);
  await offer({ type: "inspect" });
  assert.equal((await h.status()).record.units[0].phase, "examination");
  await offer({ type: "accept", note: "証拠未提出と本番未確認を留保" });
  s = (await h.status()).record;
  assert.equal(s.units[0].judgments.at(-1).decision, "accept");
  assert.equal(
    s.units[0].judgments.at(-1).source.hash,
    (await h.status()).sourceObservation.source.hash,
  );
  assert.deepEqual(s.units[0].judgments.at(-1).evidenceIds, []);
  assert.equal(s.activeUnit, 1, "acceptance never starts a next unit");
  await offer({ type: "review" });
  await offer({ type: "finish" });
  assert.equal((await h.status()).record.enabled, false);
});

test("guided cancellation/chat and stale state/source/session dialogs never apply or partially register an edge", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mentor-card-"));
  try {
    execFileSync("git", ["-C", dir, "init", "-q"]);
    writeFileSync(join(dir, "code.ts"), "before");
    execFileSync("git", ["-C", dir, "add", "."]);
    const h = harness(SessionManager.inMemory(), dir);
    await h.emit("session_start");
    await h.command("resume");
    const p = {
      summary: "目標を整理",
      unresolved: "本番未確認",
      edge: { type: "goals", goal: "安全な入力", constraints: "API維持" },
    };
    await h.next(p);
    const before = (await h.status()).record;
    const count = h.manager.getEntries().length;
    h.cardResults.push("continue");
    await h.command();
    await h.emit("context", {
      messages: [{ role: "user", content: "OK、質問がある", timestamp: 1 }],
    });
    await h.emit("agent_end");
    assert.deepEqual((await h.status()).record, before);
    assert.equal(h.manager.getEntries().length, count);
    assert.equal(h.requests.length, 0);
    let resolve!: (value: string | undefined) => void;
    let opened = dialogReady();
    h.inspector = () =>
      new Promise((done) => {
        resolve = done;
        opened.resolve();
      });
    let dialog = h.command();
    await opened.promise;
    writeFileSync(join(dir, "code.ts"), "changed while card open");
    resolve("edge");
    await dialog;
    assert.deepEqual((await h.status()).record, before);
    assert.match(h.notices.at(-1)!, /state changed/);
    await h.next(p);
    opened = dialogReady();
    dialog = h.command();
    await opened.promise;
    await h.record({ type: "proposal", text: "候補後の別記録" });
    resolve("edge");
    await dialog;
    assert.equal((await h.status()).record.goal, "");
    assert.match(h.notices.at(-1)!, /state changed/);
    await h.next(p);
    opened = dialogReady();
    dialog = h.command();
    await opened.promise;
    h.manager = SessionManager.inMemory();
    await h.emit("session_start");
    resolve("edge");
    await dialog;
    assert.equal(h.manager.getEntries().length, 0);
    assert.equal((await h.status()).record.goal, "");
    assert.match(h.notices.at(-1)!, /session changed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("guided entry, alternatives and topic menus use keyboard selection without consuming editor text", async () => {
  const h = harness();
  await h.emit("session_start");
  h.choices.push("Mentor を開始・再開");
  await h.command();
  assert.equal((await h.status()).record.enabled, true);
  h.edits.push("j/k を文字として保持");
  await h.command("goal");
  assert.equal((await h.status()).record.goal, "j/k を文字として保持");
  h.edits.push("入力検証");
  await h.command("add");
  h.cardResults.push("other", "continue");
  h.choices.push("別の論点・作業の相談に戻る…", "論点 1: 入力検証");
  await h.command();
  assert.ok(h.menus.some((m) => m.title.startsWith("その他")));
  assert.ok(h.menus.some((m) => m.title.startsWith("戻る相談")));
  assert.equal(
    (await h.status()).record.activeIssue,
    null,
    "selecting a topic prepares a card, not a state change",
  );
});

const repair = {
  summary: "これは操作ラベルではない",
  unresolved: "読者の条件は議論を続ける",
  edge: { type: "critique", text: "読者の視点を含む正確な修正案" },
};
async function stuck(cwd?: string) {
  const h = cwd ? harness(SessionManager.inMemory(), cwd) : await prepared();
  if (cwd) {
    await h.emit("session_start");
    await h.command("resume");
    h.edits.push("論点");
    await h.command("add");
    h.choices.push("#1 論点");
    await h.command("select");
    h.edits.push("現在の案");
    await h.command("hypothesis");
  }
  await h.record({ type: "draft", issueId: 1, text: repair.edge.text });
  h.choices.push("論点の検討", "判断");
  await h.command("phase");
  await h.emit("input", { source: "interactive", text: "操作で詰まった。修正案を対象に戻して" });
  return h;
}

test("assistance needs real one-time native approval; exact repair preserves history without adoption, start or acceptance", async () => {
  const h = await stuck();
  const before = (await h.status()).record;
  const offer = await h.next(repair);
  assert.equal(offer.details.operationStatus, "proposed");
  assert.equal(offer.details.label, "この修正案を検討対象にして批判・弁護する");
  assert.notEqual(offer.details.label, repair.summary);
  assert.equal((await h.status()).record.issues[0].currentRevision, 1);
  h.cardResults.push("continue");
  assert.equal((await h.assist(repair)).details.operationStatus, "cancelled");
  assert.equal((await h.status()).record.issues[0].inner, "judgment");
  const count = h.manager.getEntries().length;
  await h.emit("input", { source: "interactive", text: "修正案を対象に戻す確認をもう一度出して" });
  h.cardResults.push("edge");
  const result = await h.assist(repair, { ctx: { ...h.ctx(), isIdle: () => false } });
  assert.equal(result.details.operationStatus, "applied", JSON.stringify(result.details));
  const after = (await h.status()).record;
  assert.equal(h.manager.getEntries().length, count + 1);
  assert.equal(after.issues[0].currentRevision, 2);
  assert.equal(after.issues[0].inner, "critique");
  assert.equal(after.issues[0].revisions.length, 2);
  assert.deepEqual(after.issues[0].judgments, before.issues[0].judgments);
  assert.deepEqual(after.issues[0].critiques, before.issues[0].critiques);
  assert.deepEqual(after.units, before.units);
  assert.match(result.details.feedback, /r1 → r2/);
  assert.match(h.notices.at(-1)!, /読者の視点を含む正確な修正案/);
  assert.match(h.notices.at(-1)!, /批判・弁護する/);
});

test("native assistance authorizes exact adoption, scope, start and acceptance only after affirmative selection, one atomic entry each", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mentor-authority-"));
  try {
    execFileSync("git", ["-C", dir, "init", "-q"]);
    writeFileSync(join(dir, "code.ts"), "synthetic observed source");
    execFileSync("git", ["-C", dir, "add", "."]);
    const h = await stuck(dir);
    const approve = async (edge: object, expectedText: string[]) => {
      const proposal = { summary: "今回の正確な操作", unresolved: "実サービスは未確認", edge };
      const before = (await h.status()).record;
      const count = h.manager.getEntries().length;
      h.cardResults.push("continue");
      const cancelled = await h.assist(proposal);
      assert.equal(
        cancelled.details.operationStatus,
        "cancelled",
        JSON.stringify(cancelled.details),
      );
      assert.deepEqual((await h.status()).record, before);
      assert.equal(h.manager.getEntries().length, count, "default Enter cancels without any entry");
      await h.emit("input", {
        source: "interactive",
        text: "この正確な操作の承認画面をもう一度出して",
      });
      let resolve!: (value: string) => void, opened!: () => void;
      const ready = new Promise<void>((done) => {
        opened = done;
      });
      h.inspector = () =>
        new Promise((done) => {
          resolve = done;
          opened();
        });
      const pending = h.assist(proposal);
      await ready;
      assert.deepEqual(
        (await h.status()).record,
        before,
        "preparing and displaying are not authority",
      );
      assert.equal(h.manager.getEntries().length, count);
      const body = h.approvalBodies.at(-1)!;
      for (const text of expectedText)
        assert.ok(body.includes(text), `approval must expose ${text}: ${body}`);
      assert.ok(!body.includes("適用しました:"), "approval must not claim an applied result");
      assert.ok(
        !body.includes("この一回だけの承認です。採用・実装許可・結果の受け入れは記録しません。"),
      );
      resolve("edge");
      const applied = await pending;
      h.inspector = undefined;
      assert.equal(applied.details.operationStatus, "applied", JSON.stringify(applied.details));
      assert.equal(h.manager.getEntries().length, count + 1);
      const after = (await h.status()).record;
      assert.equal(after.sequence, before.sequence + 1);
      assert.equal(after.guided.history.length, (before.guided?.history.length ?? 0) + 1);
      assert.match(applied.details.feedback, /適用しました:/);
      assert.equal(
        h.requests.length,
        0,
        "approval never automatically starts inference or another operation",
      );
      return after;
    };
    let s = await approve({ type: "adopt", note: "方向だけを採用" }, [
      "現在の案",
      "方向だけを採用",
      "実装は許可しません",
    ]);
    assert.equal(s.issues[0].judgments.at(-1).decision, "adopt");
    assert.equal(s.issues[0].judgments.at(-1).author, "human");
    assert.equal(s.whole, "implementation");
    assert.equal(s.activeUnit, null);
    assert.equal(s.units.length, 0, "adoption never starts implementation");
    const contract = {
      ...unitContract,
      kind: "experiment",
      expectations: [...unitContract.expectations, { id: "E2", text: "実サービスで拒否" }],
    };
    s = await approve({ type: "scope", contract }, [
      "仮説実験（設計採用ではない）",
      contract.scope,
      "まだ実装・実験を開始せず",
    ]);
    assert.equal(s.units[0].phase, "scope");
    assert.deepEqual(s.units[0].revisions[0].contract, contract);
    s = await approve({ type: "start", contract }, [
      contract.scope,
      "E1: 過大入力を拒否",
      "E2: 実サービスで拒否",
      contract.nonGoals,
      contract.verificationPlan,
      "この単位だけの実装・検証を明示的に許可",
    ]);
    assert.equal(s.units[0].phase, "implementing");
    assert.deepEqual(s.units[0].revisions.at(-1).contract, contract);
    assert.equal(s.units[0].revisions.at(-1).confirmed, true);
    const status = await h.status();
    const revision = s.units[0].currentRevision;
    assert.equal(
      (
        await h.record({
          type: "unitEvidence",
          unitId: 1,
          revision,
          sourceHash: status.sourceObservation.source.hash,
          entries: [
            {
              expectationId: "E1",
              observation: "代替APIで拒否を観測",
              references: ["node check-input.ts; exit 0; response 400"],
              method: "substitute",
              limitations: "本番サービス未確認",
            },
          ],
          concerns: "実サービスの挙動は未知",
        })
      ).isError,
      undefined,
    );
    h.cardResults.push("edge");
    assert.equal(
      (await h.assist({ summary: "結果を調べる", unresolved: "", edge: { type: "inspect" } }))
        .details.operationStatus,
      "applied",
    );
    s = await approve({ type: "accept", note: "不足と代替検証を留保して受け入れる" }, [
      contract.scope,
      "E2: 実サービスで拒否",
      status.sourceObservation.source.hash,
      "代替APIで拒否を観測",
      "node check-input.ts; exit 0; response 400",
      "substitute",
      "本番サービス未確認",
      "実サービスの挙動は未知",
      "証拠なし",
      "不足と代替検証を留保して受け入れる",
      "次の実装は開始しません",
      "設計・機能採用ではありません",
    ]);
    const judgment = s.units[0].judgments.at(-1);
    assert.equal(judgment.decision, "accept");
    assert.equal(judgment.author, "human");
    assert.equal(judgment.revision, revision);
    assert.equal(judgment.source.hash, status.sourceObservation.source.hash);
    assert.deepEqual(judgment.evidenceIds, [1]);
    assert.equal(s.activeUnit, 1);
    assert.equal(s.units.length, 1);
    assert.equal(s.units[0].phase, "judgment", "acceptance never starts a next unit");
    assert.equal(s.issues[0].judgments.length, 1, "experiment acceptance never adopts a design");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("assistance rejects missing/synthesized input, no UI, paused, busy and aborted requests without mutation", async () => {
  const h = await stuck();
  const before = (await h.status()).record;
  await h.emit("input", { source: "extension", text: "操作してよいという引用" });
  assert.equal((await h.assist(repair)).isError, true);
  await h.emit("input", { source: "interactive", text: "修正案へ戻して" });
  assert.equal((await h.assist(repair, { ctx: { ...h.ctx(), hasUI: false } })).isError, true);
  await h.emit("tool_execution_start", { toolCallId: "other", toolName: "bash" });
  assert.equal((await h.assist(repair)).isError, true);
  await h.emit("tool_execution_end", { toolCallId: "other", toolName: "bash" });
  const controller = new AbortController();
  controller.abort();
  assert.equal((await h.assist(repair, { signal: controller.signal })).isError, true);
  assert.deepEqual((await h.status()).record, before);
  await h.command("pause");
  const paused = (await h.status()).record;
  assert.equal((await h.assist(repair)).isError, true);
  assert.deepEqual((await h.status()).record, paused);
});

test("open native approval rejects cancellation and stale state/source/session/branch/request/tool activity atomically", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mentor-assist-"));
  try {
    execFileSync("git", ["-C", dir, "init", "-q"]);
    writeFileSync(join(dir, "code.ts"), "original");
    execFileSync("git", ["-C", dir, "add", "."]);
    for (const boundary of [
      "cancel",
      "abort",
      "state",
      "source",
      "session",
      "branch",
      "request",
      "tool",
      "concurrent",
    ]) {
      writeFileSync(join(dir, "code.ts"), "original");
      const h = await stuck(dir);
      const before = (await h.status()).record;
      let resolve!: (value: string) => void, opened!: () => void;
      const ready = new Promise<void>((done) => {
        opened = done;
      });
      h.inspector = () =>
        new Promise((done) => {
          resolve = done;
          opened();
        });
      const controller = new AbortController();
      const open = h.assist(repair, { signal: controller.signal });
      await ready;
      if (boundary === "abort") controller.abort();
      if (boundary === "state") await h.record({ type: "proposal", text: "別記録" });
      if (boundary === "source") writeFileSync(join(dir, "code.ts"), "changed");
      if (boundary === "session") {
        h.manager = SessionManager.inMemory();
        await h.emit("session_start");
      }
      if (boundary === "branch") {
        h.manager.branch(h.manager.getBranch()[0].id);
        await h.emit("session_tree");
      }
      if (boundary === "request")
        await h.emit("input", { source: "interactive", text: "別の質問" });
      if (boundary === "tool") {
        await h.emit("tool_execution_start", {
          toolCallId: "other",
          toolName: "mentor_other_writer",
        });
        await h.emit("tool_execution_end", {
          toolCallId: "other",
          toolName: "mentor_other_writer",
        });
      }
      if (boundary === "concurrent") assert.equal((await h.assist(repair)).isError, true);
      const immediatelyBefore = (await h.status()).record;
      resolve(boundary === "cancel" ? "continue" : "edge");
      const result = await open;
      if (boundary === "concurrent") {
        assert.equal(result.details.operationStatus, "applied");
      } else {
        assert.equal(
          result.details.operationStatus,
          ["cancel", "abort"].includes(boundary) ? "cancelled" : "rejected",
          boundary,
        );
        assert.deepEqual((await h.status()).record, immediatelyBefore, boundary);
        if (!["state", "session", "branch"].includes(boundary))
          assert.deepEqual((await h.status()).record, before, boundary);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("host rejection preserves records and snapshots; failed native saves require fresh intent; defects escape", async () => {
  const h = await stuck();
  const before = await h.status();
  const count = h.manager.getEntries().length;
  h.appendFailure = new Error("Session write unavailable");
  const failed = await h.record({ type: "proposal", text: "Must not persist" });
  assert.equal(failed.isError, true);
  assert.equal(failed.details.operationError, "Session write unavailable");
  assert.equal(failed.details.snapshot, before.snapshot);
  assert.deepEqual((await h.status()).record, before.record);
  assert.equal(h.manager.getEntries().length, count);
  h.cardResults.push("edge");
  assert.equal((await h.assist(repair)).details.operationError, "Session write unavailable");
  assert.deepEqual((await h.status()).record, before.record);
  h.appendFailure = undefined;
  assert.match((await h.assist(repair)).details.operationError, /fresh explicit user intent/);
  h.editor = () => Promise.reject(new Error("Dialog unavailable"));
  await h.command("goal");
  assert.equal(h.notices.at(-1), "Dialog unavailable");
  assert.deepEqual((await h.status()).record, before.record);
  h.appendFailure = new TypeError("Unexpected adapter defect");
  await assert.rejects(
    h.record({ type: "proposal", text: "Must not disguise a defect" }),
    TypeError,
  );
  assert.equal(h.manager.getEntries().length, count);
  h.appendFailure = undefined;
  await h.emit("input", {
    source: "interactive",
    text: "保存が戻ったので修正案の確認をもう一度出して",
  });
  h.cardResults.push("edge");
  assert.equal((await h.assist(repair)).details.operationStatus, "applied");
});

test("legacy contextual menu remains available only as an explicit advanced shortcut", async () => {
  const h = await prepared();
  h.choices.push("論点の検討", "仮説形成");
  await h.command("phase");
  const before = (await h.status()).record;
  h.choices.push(
    "仮説を作成・改訂…",
    "戻る",
    "記録を見る…",
    "戻る",
    "移動・その他…",
    "全体の移動先を選ぶ…",
    "戻る（変更なし）",
    "戻る",
    "閉じる（変更なし）",
  );
  await h.command("advanced");
  assert.deepEqual((await h.status()).record, before);
  const main = h.menus.findLast((m) => m.options.includes("仮説を作成・改訂…"))!;
  assert.equal(main.options[0], "閉じる（変更なし）");
  assert.ok(main.options.includes("批判・弁護へ移る"));
  assert.ok(main.options.includes("記録を見る…"));
  assert.ok(main.options.includes("移動・その他…"));
  assert.ok(!main.options.includes("制約を編集"));
  assert.ok(!main.options.includes("現在の仮説を判断する"));
  assert.ok(main.options.length <= 8);
  h.choices.push("批判・弁護へ移る");
  await h.command("advanced");
  assert.equal((await h.status()).record.issues[0].inner, "critique");
  await h.command("advanced");
  assert.ok(h.menus.at(-1)!.options.includes("仮説の判断へ移る"));
});
