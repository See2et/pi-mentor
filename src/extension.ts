import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { Type } from 'typebox';
import { ModelActionSchema, StateSchema, applyModel, applyUser, compactRecord, initialState, mentorContext, restore, type State, type UserAction } from './domain.ts';
import { mentorMenu } from './menu.ts';
import { widgetLines } from './presentation.ts';

export default function mentorExtension(pi: ExtensionAPI): void {
  let state = initialState();
  let error: string | undefined;
  let sessionId = '';
  let epoch = 0;
  const token = () => `${sessionId}/${epoch}/${state.sequence}`;
  const checkContext = (ctx: ExtensionContext) => {
    if (ctx.sessionManager.getSessionId() !== sessionId) throw new Error('Mentor session changed; retry on the active session.');
  };
  const check = (expected: string, ctx: ExtensionContext, allowError = false) => {
    checkContext(ctx);
    if (expected !== token()) throw new Error('Mentor state changed while this operation was open. No change applied; reopen /mentor or refresh mentor_status.');
    if (error && !allowError) throw new Error(error);
  };
  const paint = (ctx: ExtensionContext) => {
    if (ctx.mode !== 'tui') return;
    ctx.ui.setWidget('mentor-location', (_tui, theme) => ({
      render: width => widgetLines(state, width, error).map(line => theme.fg(error ? 'error' : state.enabled ? 'accent' : 'muted', line)),
      invalidate() {},
    }), { placement: 'aboveEditor' });
  };
  const reconstruct = (ctx: ExtensionContext) => {
    const result = restore(ctx.sessionManager.getBranch());
    state = result.state;
    error = result.error;
    sessionId = ctx.sessionManager.getSessionId();
    epoch++;
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
  pi.on('session_shutdown', () => { epoch++; });

  // Request-local, not persisted guidance: always fresh after tools/compaction and absent while paused.
  pi.on('context', (event, ctx) => {
    checkContext(ctx);
    const messages = event.messages.filter(m => m.role !== 'custom' || !['mentor-context', 'mentor-display'].includes(m.customType));
    const guidance = error ? undefined : mentorContext(state);
    if (guidance) messages.push({ role: 'custom', customType: 'mentor-context', content: `${guidance}\nSNAPSHOT: ${token()}`, display: false, timestamp: Date.now() });
    return { messages };
  });

  pi.registerMessageRenderer('mentor-display', message => new Text(typeof message.content === 'string' ? message.content : '', 0, 0));
  pi.registerCommand('mentor', {
    description: 'Mentor: 本人操作のメニュー / status / pause / resume / hint',
    handler: async (args, ctx) => {
      if (!ctx.hasUI) { ctx.ui.notify('/mentor requires interactive or dialog-capable RPC mode.', 'error'); return; }
      try {
        checkContext(ctx);
        await mentorMenu(args, ctx, {
          state: () => structuredClone(state), error: () => error, token,
          check: expected => check(expected, ctx, true),
          user: (action: UserAction, expected: string) => {
            check(expected, ctx);
            persist(applyUser(state, action), ctx);
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
        });
      } catch (failure) {
        ctx.ui.notify(failure instanceof Error ? failure.message : String(failure), 'error');
      }
    },
  });

  const result = (full = false) => ({
    snapshot: token(), paused: !state.enabled, error,
    record: full ? state : compactRecord(state),
  });
  pi.registerTool({
    name: 'mentor_status', label: 'Mentor status',
    description: 'Read Mentor current state and complete version/critique/response/judgment history on the active branch. Returns latest snapshot for mentor_record. Read-only; works while paused. User controls all phase/issue/decision changes through /mentor.',
    parameters: Type.Object({}, { additionalProperties: false }),
    outputSchema: Type.Object({ snapshot: Type.String(), paused: Type.Boolean(), error: Type.Optional(Type.String()), record: StateSchema }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    async execute(_id, _params, _signal, _update, ctx) {
      checkContext(ctx);
      const data = result(true);
      return { content: [{ type: 'text', text: JSON.stringify(data) }], details: data, structuredContent: JSON.parse(JSON.stringify(data)) };
    },
  });
  pi.registerTool({
    name: 'mentor_record', label: 'Mentor record / propose',
    description: 'Record AI proposals, unconfirmed hypothesis drafts, grounded revision-bound critiques/corrections/withdrawals, or AI-organized reported responses. NEVER changes phase, active issue, confirmed hypothesis or human judgment. Requires exact latest snapshot (mentor_status/context); conflicting calls must refresh. Critiques need category and evidence/conditions; corrections replace an existing critique on the SAME revision, preserving history. Responses recorded here are AI reports, not human confirmations. Rejected while paused.',
    parameters: Type.Object({ expectedSnapshot: Type.String(), action: ModelActionSchema }, { additionalProperties: false }),
    outputSchema: Type.Object({ snapshot: Type.String(), paused: Type.Boolean(), error: Type.Optional(Type.String()), record: Type.Unknown(), operationError: Type.Optional(Type.String()) }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async execute(_id, params, signal, _update, ctx) {
      try {
        if (signal?.aborted) throw new Error('Mentor record cancelled.');
        check(params.expectedSnapshot, ctx);
        persist(applyModel(state, params.action), ctx);
        const data = result();
        return { content: [{ type: 'text', text: JSON.stringify(data) }], details: data, structuredContent: JSON.parse(JSON.stringify(data)) };
      } catch (failure) {
        const data = { ...result(), operationError: failure instanceof Error ? failure.message : String(failure) };
        return { content: [{ type: 'text', text: JSON.stringify(data) }], details: data, structuredContent: JSON.parse(JSON.stringify(data)), isError: true };
      }
    },
  });
}
