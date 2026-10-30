import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { Type } from 'typebox';
import { ModelActionSchema, StateSchema, applyModel, applyUser, compactRecord, initialState, mentorContext, restore, type State, type UserAction } from './domain.ts';
import { mentorMenu } from './menu.ts';
import { guidedMenu, type GuidedOwner } from './guided-menu.ts';
import { sourceIdentity, proposeNext, transition } from './guided.ts';
import { NextSchema } from './guided-schema.ts';
import { widgetLines } from './presentation.ts';
import { observeSource } from './source.ts';
import type { Observation } from './units.ts';

export default function mentorExtension(pi: ExtensionAPI): void {
  let state = initialState();
  let error: string | undefined;
  let sessionId = '';
  let epoch = 0;
  let observation: Observation = { checkedAt: '', error: 'Not checked yet' };
  const inFlight = new Set<string>();
  const token = () => `${sessionId}/${epoch}/${state.sequence}:${sourceIdentity(observation)}`;
  const refresh = (ctx: ExtensionContext) => {
    checkContext(ctx);
    observation = inFlight.size ? { checkedAt: new Date().toISOString(), error: 'Pi tool activity in flight; source freshness cannot be established.' } : observeSource(ctx.cwd ?? process.cwd());
  };
  const checkContext = (ctx: ExtensionContext) => {
    if (ctx.sessionManager.getSessionId() !== sessionId) throw new Error('Mentor session changed; retry on the active session.');
  };
  const check = (expected: string, ctx: ExtensionContext, allowError = false) => {
    checkContext(ctx);
    refresh(ctx);
    if (expected !== token()) throw new Error('Mentor state changed while this operation was open. No change applied; reopen /mentor or refresh mentor_status.');
    if (error && !allowError) throw new Error(error);
  };
  const paint = (ctx: ExtensionContext) => {
    if (ctx.mode !== 'tui') return;
    ctx.ui.setWidget('mentor-location', (_tui, theme) => ({
      render: width => widgetLines(state, width, error, observation).map(line => theme.fg(error ? 'error' : state.enabled ? 'accent' : 'muted', line)),
      invalidate() {},
    }), { placement: 'aboveEditor' });
  };
  const reconstruct = (ctx: ExtensionContext) => {
    const result = restore(ctx.sessionManager.getBranch());
    state = result.state;
    error = result.error;
    sessionId = ctx.sessionManager.getSessionId();
    epoch++;
    inFlight.clear();
    refresh(ctx);
    paint(ctx);
    if (error && ctx.hasUI) ctx.ui.notify(error, 'error');
  };
  const persist = (next: State, ctx: ExtensionContext) => {
    // appendEntry is synchronous: no dialog/await may split validation from commit.
    checkContext(ctx);
    pi.appendEntry('mentor-state', next);
    state = next;
    paint(ctx);
  };
  pi.on('session_start', (_event, ctx) => reconstruct(ctx));
  pi.on('session_tree', (_event, ctx) => reconstruct(ctx));
  pi.on('session_compact', (_event, ctx) => reconstruct(ctx));
  pi.on('session_shutdown', () => { epoch++; inFlight.clear(); });
  pi.on('tool_execution_start', (event, ctx) => {
    if (!event.toolName.startsWith('mentor_')) inFlight.add(event.toolCallId);
    refresh(ctx); paint(ctx);
  });
  pi.on('tool_execution_end', (event, ctx) => {
    inFlight.delete(event.toolCallId);
    refresh(ctx); paint(ctx);
  });
  pi.on('agent_end', (_event, ctx) => { refresh(ctx); paint(ctx); });

  // Request-local, not persisted guidance: always fresh after tools/compaction and absent while paused.
  pi.on('context', (event, ctx) => {
    checkContext(ctx);
    const messages = event.messages.filter(m => m.role !== 'custom' || !['mentor-context', 'mentor-display'].includes(m.customType));
    refresh(ctx); paint(ctx);
    const guidance = error ? undefined : mentorContext(state, observation);
    if (guidance) messages.push({ role: 'custom', customType: 'mentor-context', content: `${guidance}\nSNAPSHOT: ${token()}`, display: false, timestamp: Date.now() });
    return { messages };
  });

  pi.registerMessageRenderer('mentor-display', message => new Text(typeof message.content === 'string' ? message.content : '', 0, 0));
  pi.registerCommand('mentor', {
    description: 'Mentor: 現在の相談と次の一手 / status / pause / resume / hint',
    handler: async (args, ctx) => {
      if (!ctx.hasUI) { ctx.ui.notify('/mentor requires interactive or dialog-capable RPC mode.', 'error'); return; }
      try {
        checkContext(ctx);
        refresh(ctx); paint(ctx);
        const owner: GuidedOwner = {
          state: () => structuredClone(state), observation: () => structuredClone(observation), error: () => error, token,
          check: expected => check(expected, ctx, true),
          user: (action: UserAction, expected: string) => {
            check(expected, ctx);
            persist(applyUser(state, action, observation), ctx);
          },
          edge: (proposal, expected) => {
            check(expected, ctx);
            persist(transition(state, proposal, observation), ctx);
          },
          reset: expected => {
            check(expected, ctx, true);
            persist(initialState(), ctx);
            error = undefined;
            epoch++;
            paint(ctx);
          },
          view: text => { checkContext(ctx); pi.sendMessage({ customType: 'mentor-display', content: text, display: true, details: undefined }, { triggerTurn: false }); },
          ask: text => {
            checkContext(ctx);
            if (!ctx.isIdle()) throw new Error('Pi is busy; request the hint/discussion again after the current response.');
            pi.sendUserMessage(text, { expandPromptTemplates: false });
          },
        };
        if (!args.trim()) await guidedMenu(ctx, owner);
        else await mentorMenu(args.trim() === 'advanced' ? '' : args, ctx, owner);
      } catch (failure) {
        ctx.ui.notify(failure instanceof Error ? failure.message : String(failure), 'error');
      }
    },
  });

  const result = (full = false) => ({
    snapshot: token(), paused: !state.enabled, error,
    sourceObservation: observation,
    record: full ? state : compactRecord(state, observation),
  });
  pi.registerTool({
    name: 'mentor_status', label: 'Mentor status',
    description: 'Read Mentor current state and complete version/critique/response/judgment history on the active branch. Returns latest snapshot for mentor_record. Read-only; works while paused. User controls all phase/issue/decision changes through /mentor.',
    parameters: Type.Object({}, { additionalProperties: false }),
    outputSchema: Type.Object({ snapshot: Type.String(), paused: Type.Boolean(), error: Type.Optional(Type.String()), sourceObservation: Type.Unknown(), record: StateSchema }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    async execute(_id, _params, _signal, _update, ctx) {
      checkContext(ctx);
      refresh(ctx); paint(ctx);
      const data = result(true);
      return { content: [{ type: 'text', text: JSON.stringify(data) }], details: data, structuredContent: JSON.parse(JSON.stringify(data)) };
    },
  });
  pi.registerTool({
    name: 'mentor_next', label: 'Mentor next-action draft',
    description: 'Prepare ONE current-artifact/next-action card from the conversation. Does NOT select an edge, change phase, adopt, authorize implementation or accept anything. Call after recording critiques/evidence: later state or source changes make the card stale. Provide a concise summary, unresolved matters and the exact typed edge payload. Only the user can apply it through /mentor; all necessary records and movement commit atomically. goals stores goal+constraints; issue creates/selects an exact issue; critique text sets the exact review target (not adoption); decide opens the direction discussion; adopt records provisional adoption and opens scope discussion (not implementation); scope records a new feature/experiment scope without starting; start confirms the exact contract and explicitly starts ONLY that unit; inspect stops implementation for inspection; accept binds the displayed contract/source/evidence/limitations; correct explicitly restarts implementation within the current contract; design/revise/defer/review/finish are explicit loops or whole review. Use scope for experiments without inferring design adoption. No free-form action labels, user actions, automatic transitions or grading. Require the latest snapshot.',
    parameters: Type.Object({ expectedSnapshot: Type.String(), proposal: NextSchema }, { additionalProperties: false }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async execute(_id, params, signal, _update, ctx) {
      try {
        if (signal?.aborted) throw new Error('Mentor next-action draft cancelled.');
        check(params.expectedSnapshot, ctx);
        persist(proposeNext(state, params.proposal, observation), ctx);
        const data = result();
        return { content: [{ type: 'text', text: JSON.stringify(data) }], details: data, structuredContent: JSON.parse(JSON.stringify(data)) };
      } catch (failure) {
        const data = { ...result(), operationError: failure instanceof Error ? failure.message : String(failure) };
        return { content: [{ type: 'text', text: JSON.stringify(data) }], details: data, structuredContent: JSON.parse(JSON.stringify(data)), isError: true };
      }
    },
  });
  pi.registerTool({
    name: 'mentor_record', label: 'Mentor record / propose',
    description: 'Record AI unitDraft contracts (feature or experiment), unitEvidence, unitReport readiness/concerns, unitSuggestion optional learning prompts, AI proposals, unconfirmed hypothesis drafts, grounded revision-bound critiques/corrections/withdrawals, or AI-organized reported responses. Unit evidence must reference valid expectation IDs, exact current contract revision and sourceHash actually observed by mentor_status; source is rechecked on commit. Include actual observations, references/commands/results, real/substitute/untested methods, limitations and concerns. Tests passing does not decide expectations. No execution orchestration. Unit drafts need exact human confirmation before start. Reports/suggestions never record human understanding or acceptance. NEVER changes phase, active issue, confirmed hypothesis or human judgment. Requires exact latest snapshot (mentor_status/context); conflicting calls must refresh. Critiques need category and evidence/conditions; corrections replace an existing critique on the SAME revision, preserving history. Responses recorded here are AI reports, not human confirmations. Rejected while paused.',
    parameters: Type.Object({ expectedSnapshot: Type.String(), action: ModelActionSchema }, { additionalProperties: false }),
    outputSchema: Type.Object({ snapshot: Type.String(), paused: Type.Boolean(), error: Type.Optional(Type.String()), sourceObservation: Type.Unknown(), record: Type.Unknown(), operationError: Type.Optional(Type.String()) }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async execute(_id, params, signal, _update, ctx) {
      try {
        if (signal?.aborted) throw new Error('Mentor record cancelled.');
        check(params.expectedSnapshot, ctx);
        persist(applyModel(state, params.action, observation), ctx);
        const data = result();
        return { content: [{ type: 'text', text: JSON.stringify(data) }], details: data, structuredContent: JSON.parse(JSON.stringify(data)) };
      } catch (failure) {
        const data = { ...result(), operationError: failure instanceof Error ? failure.message : String(failure) };
        return { content: [{ type: 'text', text: JSON.stringify(data) }], details: data, structuredContent: JSON.parse(JSON.stringify(data)), isError: true };
      }
    },
  });
}
