import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { ok, safeTry } from "neverthrow";
import { Type } from "typebox";
import { actionCard } from "./card.ts";
import {
  requireApprovalAvailable,
  requireApprovalCurrent,
  requireFreshIntent,
  requireSnapshot,
  snapshotToken,
  sourceIdentity,
} from "./domain/approval.ts";
import { DiscussionActionSchema } from "./domain/design.ts";
import { reject, type Failure, type Outcome } from "./domain/errors.ts";
import { initialState, type State } from "./domain/state.ts";
import type { Observation } from "./domain/work-unit.ts";
import { NextSchema } from "./domain/workflow-schema.ts";
import {
  applyDiscussion,
  applyModel,
  applyUser,
  ModelActionSchema,
  proposeNext,
  transition,
  type ModelAction,
  type UserAction,
} from "./domain/workflow.ts";
import { guidedMenu, type GuidedOwner } from "./guided-menu.ts";
import { hostAsync, hostCall } from "./host.ts";
import { mentorMenu } from "./menu.ts";
import { restore } from "./persistence.ts";
import { widgetLines } from "./widget.ts";
import {
  actionMeaning,
  exactArtifact,
  operationFeedback,
  workTitle,
} from "./presentation/action.ts";
import { mentorContext } from "./presentation/record.ts";
import { observeSource } from "./source.ts";
import { StatusSchema, statusView } from "./status.ts";

export default function mentorExtension(pi: ExtensionAPI): void {
  let state = initialState();
  let error: string | undefined;
  let sessionId = "";
  let epoch = 0;
  let observation: Observation = { checkedAt: "", error: "Not checked yet" };
  const inFlight = new Set<string>();
  const sourceActivity = new Set<string>();
  const mentorTools = new Set([
    "mentor_status",
    "mentor_record",
    "mentor_next",
    "mentor_assist",
    "mentor_discuss",
  ]);
  const syncTools = () => {
    const unrelated = pi.getActiveTools().filter((name) => !mentorTools.has(name));
    // Pi registers codemode inactive by default; paused status still needs its entry point.
    if (!unrelated.includes("codemode")) unrelated.push("codemode");
    pi.setActiveTools(
      state.enabled && !error ? [...unrelated, "mentor_assist", "mentor_discuss"] : unrelated,
    );
  };
  let activity = 0;
  let approvalOpen = false;
  let inputVersion = 0;
  let declinedInputVersion: number | undefined;
  let latestInput: { text: string; source: "interactive" | "rpc" } | undefined;
  const token = () => snapshotToken(sessionId, epoch, state.sequence, observation);
  const refresh = (ctx: ExtensionContext): Outcome<void> =>
    checkContext(ctx).map(() => {
      observation = sourceActivity.size
        ? {
            checkedAt: new Date().toISOString(),
            error: "Pi tool activity in flight; source freshness cannot be established.",
          }
        : observeSource(ctx.cwd ?? process.cwd());
    });
  const checkContext = (ctx: ExtensionContext): Outcome<void> =>
    ctx.sessionManager.getSessionId() === sessionId
      ? ok(undefined)
      : reject("Mentor session changed; retry on the active session.", "freshness");
  const check = (expected: string, ctx: ExtensionContext, allowError = false): Outcome<void> =>
    safeTry(function* () {
      yield* checkContext(ctx);
      yield* refresh(ctx);
      yield* requireSnapshot(expected, token());
      return error && !allowError ? reject(error, "persistence") : ok(undefined);
    });
  const paint = (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setWidget(
      "mentor-location",
      (_tui, theme) => ({
        render: (width) =>
          widgetLines(state, width, error, observation).map((line) =>
            theme.fg(error ? "error" : state.enabled ? "accent" : "muted", line),
          ),
        invalidate() {},
      }),
      { placement: "aboveEditor" },
    );
  };
  const observeAndPaint = (ctx: ExtensionContext) => {
    const observed = refresh(ctx);
    if (observed.isErr()) {
      if (ctx.hasUI) ctx.ui.notify(observed.error.message, "error");
      return;
    }
    paint(ctx);
  };
  const reconstruct = (ctx: ExtensionContext) => {
    const result = restore(ctx.sessionManager.getBranch());
    state = result.state;
    error = result.error;
    sessionId = ctx.sessionManager.getSessionId();
    epoch++;
    latestInput = undefined;
    declinedInputVersion = undefined;
    inputVersion++;
    inFlight.clear();
    sourceActivity.clear();
    syncTools();
    observeAndPaint(ctx);
    if (error && ctx.hasUI) ctx.ui.notify(error, "error");
  };
  const persist = (next: State, ctx: ExtensionContext): Outcome<void> =>
    safeTry(function* () {
      // appendEntry is synchronous: no dialog/await may split validation from commit.
      yield* checkContext(ctx);
      yield* hostCall(() => pi.appendEntry("mentor-state", next), "persistence");
      state = next;
      syncTools();
      paint(ctx);
      return ok(undefined);
    });
  pi.on("session_start", (_event, ctx) => reconstruct(ctx));
  pi.on("session_tree", (_event, ctx) => reconstruct(ctx));
  pi.on("session_compact", (_event, ctx) => reconstruct(ctx));
  pi.on("session_shutdown", () => {
    epoch++;
    latestInput = undefined;
    inputVersion++;
    inFlight.clear();
    sourceActivity.clear();
  });
  pi.on("input", (event) => {
    inputVersion++;
    latestInput =
      event.source === "interactive" || event.source === "rpc"
        ? { text: event.text, source: event.source }
        : undefined;
    return { action: "continue" };
  });
  pi.on("tool_execution_start", (event, ctx) => {
    if (!mentorTools.has(event.toolName)) {
      inFlight.add(event.toolCallId);
      activity++;
      // Codemode orchestrates nested tools, which report their own source activity.
      // Keep the container busy for native approval guards, not source observation.
      if (event.toolName !== "codemode") sourceActivity.add(event.toolCallId);
    }
    observeAndPaint(ctx);
  });
  pi.on("tool_execution_end", (event, ctx) => {
    inFlight.delete(event.toolCallId);
    sourceActivity.delete(event.toolCallId);
    observeAndPaint(ctx);
  });
  pi.on("agent_end", (_event, ctx) => observeAndPaint(ctx));

  // Request-local, not persisted guidance: always fresh after tools/compaction and absent while paused.
  pi.on("context", (event, ctx) => {
    const messages = event.messages.filter(
      (m) => m.role !== "custom" || !["mentor-context", "mentor-display"].includes(m.customType),
    );
    const observed = refresh(ctx);
    if (observed.isErr()) {
      if (ctx.hasUI) ctx.ui.notify(observed.error.message, "error");
      return { messages };
    }
    paint(ctx);
    const guidance = error ? undefined : mentorContext(state, observation);
    if (guidance)
      messages.push({
        role: "custom",
        customType: "mentor-context",
        content: `${guidance}\nSNAPSHOT: ${token()}`,
        display: false,
        timestamp: Date.now(),
      });
    return { messages };
  });

  pi.registerMessageRenderer(
    "mentor-display",
    (message) => new Text(typeof message.content === "string" ? message.content : "", 0, 0),
  );
  pi.registerCommand("mentor", {
    description: "Mentor: 現在の相談と次の一手 / status / pause / resume / hint",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/mentor requires interactive or dialog-capable RPC mode.", "error");
        return;
      }
      const outcome = await safeTry(async function* () {
        yield* checkContext(ctx);
        yield* refresh(ctx);
        paint(ctx);
        const owner: GuidedOwner = {
          state: () => structuredClone(state),
          observation: () => structuredClone(observation),
          error: () => error,
          token,
          check: (expected) => check(expected, ctx, true),
          user: (action: UserAction, expected: string) =>
            check(expected, ctx)
              .andThen(() => applyUser(state, action, observation))
              .andThen((next) => persist(next, ctx)),
          edge: (proposal, expected) =>
            safeTry(function* () {
              yield* check(expected, ctx);
              const next = yield* transition(state, proposal, observation);
              const feedback = operationFeedback(state, next, proposal);
              yield* persist(next, ctx);
              ctx.ui.notify(feedback, "info");
              return ok(undefined);
            }),
          reset: (expected) =>
            safeTry(function* () {
              yield* check(expected, ctx, true);
              yield* persist(initialState(), ctx);
              error = undefined;
              epoch++;
              paint(ctx);
              return ok(undefined);
            }),
          view: (text) =>
            checkContext(ctx).andThen(() =>
              hostCall(() =>
                pi.sendMessage(
                  {
                    customType: "mentor-display",
                    content: text,
                    display: true,
                    details: undefined,
                  },
                  { triggerTurn: false },
                ),
              ),
            ),
          ask: (text) =>
            safeTry(function* () {
              yield* checkContext(ctx);
              if (!ctx.isIdle())
                return reject(
                  "Pi is busy; request the hint/discussion again after the current response.",
                  "authority",
                );
              yield* hostCall(() => pi.sendUserMessage(text, { expandPromptTemplates: false }));
              return ok(undefined);
            }),
        };
        if (!args.trim()) yield* await guidedMenu(ctx, owner);
        else yield* await mentorMenu(args.trim() === "advanced" ? "" : args, ctx, owner);
        return ok(undefined);
      });
      return outcome.match(
        (value) => value,
        (failure) => {
          ctx.ui.notify(failure.message, "error");
        },
      );
    },
  });

  const namespace = {
    name: "mentor",
    description:
      "Mentor records and /mentor card drafts. Discover schemas with describeTool; serialize writes with the latest snapshot. Native approval uses mentor_assist, never scripts.",
  };
  const result = () => ({
    snapshot: token(),
    paused: !state.enabled,
    error,
    operationStatus: "unchanged",
    sourceObservation: observation,
    location: { whole: state.whole, issueId: state.activeIssue, unitId: state.activeUnit },
    recovery:
      "Read mentor_status via codemode for current state; refresh before retrying stale writes. Only /mentor can resume/reset.",
  });
  const recorded = (action: ModelAction) => {
    if (action.type === "proposal")
      return { type: action.type, proposalId: state.proposals.at(-1)!.id };
    if ("issueId" in action) {
      const issue = state.issues.find((i) => i.id === action.issueId)!;
      return {
        type: action.type,
        issueId: issue.id,
        revision: action.type === "draft" ? issue.revisions.at(-1)!.revision : action.revision,
        critiqueId: action.type === "critique" ? issue.critiques.at(-1)!.id : undefined,
        responseNumber: action.type === "response" ? issue.responses.length : undefined,
      };
    }
    const unit = action.unitId
      ? state.units.find((u) => u.id === action.unitId)!
      : state.units.at(-1)!;
    return {
      type: action.type,
      unitId: unit.id,
      revision: action.type === "unitDraft" ? unit.revisions.at(-1)!.revision : action.revision,
      evidenceId: action.type === "unitEvidence" ? unit.evidence.at(-1)!.id : undefined,
      reportNumber: action.type === "unitReport" ? unit.reports.length : undefined,
      noteNumber: action.type === "unitSuggestion" ? unit.notes.length : undefined,
    };
  };
  pi.registerTool({
    name: "mentor_status",
    label: "Mentor status",
    exposure: "codemode",
    namespace,
    description:
      "Read current summary (default), complete issue/unit by ID, or explicit full branch history. Includes omissions/recovery, exact source observation and latest snapshot. Read-only; works while paused. Human decisions require /mentor or native approval, never chat assent.",
    parameters: StatusSchema,
    outputSchema: Type.Object(
      {
        snapshot: Type.String(),
        paused: Type.Boolean(),
        record: Type.Optional(Type.Unknown()),
        operationError: Type.Optional(Type.String()),
      },
      { additionalProperties: true },
    ),
    annotations: { readOnlyHint: true, openWorldHint: false },
    async execute(_id, params, _signal, _update, ctx) {
      const outcome = safeTry(function* () {
        yield* checkContext(ctx);
        yield* refresh(ctx);
        paint(ctx);
        const data = { ...result(), ...(yield* statusView(state, params, observation)) };
        return ok({
          content: [{ type: "text" as const, text: JSON.stringify(data) }],
          details: data,
          structuredContent: JSON.parse(JSON.stringify(data)),
        });
      });
      return outcome.match(
        (value) => value,
        (failure) => {
          const data = {
            ...result(),
            operationError: failure.message,
            recovery:
              "Read mentor_status({}) via codemode to discover IDs; use view issue + issueId, unit + unitId, or full.",
          };
          return {
            content: [{ type: "text" as const, text: JSON.stringify(data) }],
            details: data,
            structuredContent: JSON.parse(JSON.stringify(data)),
            isError: true,
          };
        },
      );
    },
  });
  pi.registerTool({
    name: "mentor_next",
    label: "Mentor next-action draft",
    exposure: "codemode",
    namespace,
    description:
      "Draft ONE exact typed /mentor card; never apply its effects. Latest snapshot required; call last after records/evidence (state/source changes stale it). Include summary and unresolved matters. Only user selection of the returned label—not summary—applies atomically, with no later confirmation. adopt is direction only; scope does not start; start/correct authorize only the exact unit contract; accept binds contract/source/evidence/limitations, never starts work or adopts an experiment as design. No automatic transitions or grading.",
    parameters: Type.Object(
      { expectedSnapshot: Type.String(), proposal: NextSchema },
      { additionalProperties: false },
    ),
    outputSchema: Type.Object({ snapshot: Type.String() }, { additionalProperties: true }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async execute(_id, params, signal, _update, ctx) {
      const outcome = safeTry(function* () {
        if (signal?.aborted) return reject("Mentor next-action draft cancelled.", "cancelled");
        yield* check(params.expectedSnapshot, ctx);
        yield* persist(yield* proposeNext(state, params.proposal, observation), ctx);
        const data = {
          ...result(),
          operationStatus: "proposed",
          ...actionMeaning(params.proposal.edge, state),
          interaction:
            "Select the actual action label in /mentor to apply immediately. No extra confirmation follows. Summary is not the label.",
        };
        return ok({
          content: [{ type: "text" as const, text: JSON.stringify(data) }],
          details: data,
          structuredContent: JSON.parse(JSON.stringify(data)),
        });
      });
      return outcome.match(
        (value) => value,
        (failure) => {
          const data = { ...result(), operationError: failure.message };
          return {
            content: [{ type: "text" as const, text: JSON.stringify(data) }],
            details: data,
            structuredContent: JSON.parse(JSON.stringify(data)),
            isError: true,
          };
        },
      );
    },
  });
  pi.registerTool({
    name: "mentor_assist",
    label: "Mentor one-time card approval",
    exposure: "model-only",
    defaultActive: false,
    description:
      "Offer ONE exact normal-card operation at a human decision point or explicit operation/skip request; no internal-command request needed. TUI native affirmative approval alone authorizes it, with the same preconditions/authority as /mentor. Chat, host input and quotes are context, NOT consent. Never retry cancelled/rejected approval without fresh explicit user intent. Latest snapshot required; call last after records. adopt does not start; start/correct authorize only displayed contract; accept binds contract/source/evidence/missing evidence/limitations, never next work or experiment design adoption. No advanced reset/pause, arrays, delegation or automatic follow-up. Cancel/stale/noUI/paused/busy apply nothing. Report actual applied/cancelled/rejected status.",
    parameters: Type.Object(
      { expectedSnapshot: Type.String(), proposal: NextSchema },
      { additionalProperties: false },
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async execute(_id, params, signal, _update, ctx) {
      const rejected = (failure: Failure) => {
        const data = {
          ...result(),
          operationStatus: signal?.aborted ? "cancelled" : "rejected",
          operationError: failure.message,
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data) }],
          details: data,
          structuredContent: JSON.parse(JSON.stringify(data)),
          isError: true,
        };
      };
      const prepared = safeTry(function* () {
        yield* requireApprovalAvailable({
          nativeUI: ctx.hasUI && ctx.mode === "tui",
          busy: approvalOpen || !!inFlight.size,
          aborted: !!signal?.aborted,
        });
        yield* check(params.expectedSnapshot, ctx);
        yield* requireFreshIntent(!!latestInput, inputVersion, declinedInputVersion);
        const proposal = structuredClone(params.proposal);
        const planned = yield* transition(state, proposal, observation);
        const meaning = actionMeaning(proposal.edge, state);
        const feedback = operationFeedback(state, planned, proposal);
        const expected = token(),
          version = inputVersion,
          toolsVersion = activity,
          leaf = ctx.sessionManager.getLeafId();
        const candidate = { inputVersion: version, activity: toolsVersion, inFlight: false, leaf };
        const request = structuredClone(latestInput!);
        const body = `実際の直近入力 (${request.source}、依頼の文脈のみ・承認ではない):\n${request.text}\n\nセッション: ${sessionId}\n記録: ${state.sequence} / 枝の末尾: ${leaf ?? "なし"}\n最終確認ソース: ${sourceIdentity(observation)}\n（最終確認時の一致のみ。原子的・ライブ監視ではありません）\n\n現在の相談: ${workTitle(state)}\n適用後の相談: ${workTitle(planned)}\n操作: ${meaning.label}\n選ぶと: ${meaning.effect}\n\n${yield* exactArtifact(state, proposal, observation)}\n\n承認した場合の変更:\n${operationFeedback(state, planned, proposal, "planned")}\n\n表示した内容の、この操作一回だけを承認します。通常の /mentor カードで同じ操作を選ぶ場合と同じ権限・変更です。後続の操作や次の単位の開始は承認しません。`;
        return ok({ planned, meaning, feedback, expected, version, candidate, body });
      });
      if (prepared.isErr()) return rejected(prepared.error);
      const { planned, meaning, feedback, expected, version, candidate, body } = prepared.value;
      approvalOpen = true;
      try {
        const choice = await hostAsync(() =>
          actionCard(ctx, "Mentor 操作の一回限りの承認", body, meaning.label, { signal }),
        );
        // Validation and append run synchronously together after the only dialog await.
        const applied = choice.andThen((choice) =>
          safeTry(function* () {
            if (signal?.aborted)
              return reject("Mentor assistance cancelled; no change applied.", "cancelled");
            if (choice !== "edge") {
              declinedInputVersion = version;
              const data = { ...result(), operationStatus: "cancelled", ...meaning };
              return ok({
                content: [{ type: "text" as const, text: JSON.stringify(data) }],
                details: data,
                structuredContent: JSON.parse(JSON.stringify(data)),
              });
            }
            yield* check(expected, ctx);
            yield* requireApprovalCurrent(candidate, {
              inputVersion,
              activity,
              inFlight: !!inFlight.size,
              leaf: ctx.sessionManager.getLeafId(),
            });
            yield* persist(planned, ctx);
            ctx.ui.notify(feedback, "info");
            const data = { ...result(), operationStatus: "applied", ...meaning, feedback };
            return ok({
              content: [{ type: "text" as const, text: JSON.stringify(data) }],
              details: data,
              structuredContent: JSON.parse(JSON.stringify(data)),
            });
          }),
        );
        if (applied.isErr()) declinedInputVersion = version;
        return applied.match((value) => value, rejected);
      } finally {
        approvalOpen = false;
      }
    },
  });
  pi.registerTool({
    name: "mentor_discuss",
    label: "Mentor discussion update",
    defaultActive: false,
    description:
      "Organize actual conversation with brief disclosure: goals->issues, new issue->hypothesis, exact unconfirmed target->critique, critique->direction, or rethink. Ask concrete stage questions and address answers first; no stage-racing, grading or AI-chosen skips. Never confirms/adopts, authorizes scope/start, switches units, accepts or leaves implementation. Changed targets remain unconfirmed; history stays revision-bound. Discover mentor_record/status/next via codemode describeTool; use mentor_assist for human decisions/skips. Latest snapshot required; paused rejects.",
    parameters: Type.Object(
      { expectedSnapshot: Type.String(), action: DiscussionActionSchema },
      { additionalProperties: false },
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async execute(_id, params, signal, _update, ctx) {
      const outcome = safeTry(function* () {
        if (signal?.aborted) return reject("Mentor discussion update cancelled.", "cancelled");
        yield* check(params.expectedSnapshot, ctx);
        const next = yield* applyDiscussion(state, params.action);
        const target =
          next.activeIssue === null
            ? undefined
            : next.issues.find((i) => i.id === next.activeIssue);
        const revision = target?.revisions.find((r) => r.revision === target.currentRevision);
        const title = workTitle(next)
          .replace(/[\x00-\x1f\x7f]/g, " ")
          .slice(0, 80);
        const feedback = `相談を整理: ${title}${params.action.type === "target" ? ` · 検討対象 r${revision!.revision}（${revision!.confirmed ? "本人確認済みの案を維持" : "AI整理・未確認"}）` : ""}。採用・実装許可・受け入れは変更していません。`;
        yield* persist(next, ctx);
        if (ctx.hasUI) ctx.ui.notify(feedback, "info");
        const data = { ...result(), operationStatus: "discussion-updated", feedback };
        return ok({
          content: [{ type: "text" as const, text: JSON.stringify(data) }],
          details: data,
          structuredContent: JSON.parse(JSON.stringify(data)),
        });
      });
      return outcome.match(
        (value) => value,
        (failure) => {
          const data = { ...result(), operationError: failure.message };
          return {
            content: [{ type: "text" as const, text: JSON.stringify(data) }],
            details: data,
            structuredContent: JSON.parse(JSON.stringify(data)),
            isError: true,
          };
        },
      );
    },
  });
  pi.registerTool({
    name: "mentor_record",
    label: "Mentor record / propose",
    exposure: "codemode",
    namespace,
    description:
      "Record AI drafts/proposals, grounded revision-bound critiques/corrections, reported responses, unit contracts/evidence/readiness or optional learning prompts. Never changes phase, selection, human confirmation/judgment or understanding. Exact latest snapshot required; serialize writes, refresh conflicts; paused rejects. Critique corrections reference SAME revision and preserve history; responses are AI reports. Evidence requires valid expectation IDs, exact current contract revision and sourceHash actually observed by mentor_status (rechecked at commit); include observations, references/commands/results, real/substitute/untested methods, limitations and concerns. Passing tests is not expectation satisfaction. Drafts do not authorize implementation.",
    parameters: Type.Object(
      { expectedSnapshot: Type.String(), action: ModelActionSchema },
      { additionalProperties: false },
    ),
    outputSchema: Type.Object(
      {
        snapshot: Type.String(),
        paused: Type.Boolean(),
        operationStatus: Type.Optional(Type.String()),
        operationError: Type.Optional(Type.String()),
      },
      { additionalProperties: true },
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async execute(_id, params, signal, _update, ctx) {
      const outcome = safeTry(function* () {
        if (signal?.aborted) return reject("Mentor record cancelled.", "cancelled");
        yield* check(params.expectedSnapshot, ctx);
        yield* persist(yield* applyModel(state, params.action, observation), ctx);
        const data = {
          ...result(),
          operationStatus: "recorded",
          recorded: recorded(params.action),
        };
        return ok({
          content: [{ type: "text" as const, text: JSON.stringify(data) }],
          details: data,
          structuredContent: JSON.parse(JSON.stringify(data)),
        });
      });
      return outcome.match(
        (value) => value,
        (failure) => {
          const data = { ...result(), operationError: failure.message };
          return {
            content: [{ type: "text" as const, text: JSON.stringify(data) }],
            details: data,
            structuredContent: JSON.parse(JSON.stringify(data)),
            isError: true,
          };
        },
      );
    },
  });
}
