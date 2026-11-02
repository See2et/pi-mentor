import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { Type } from 'typebox';
import { ModelActionSchema, StateSchema, applyModel, applyUser, compactRecord, initialState, mentorContext, restore, type State, type UserAction } from './domain.ts';
import { mentorMenu } from './menu.ts';
import { guidedMenu, type GuidedOwner } from './guided-menu.ts';
import { actionMeaning, operationFeedback, exactArtifact, sourceIdentity, proposeNext, transition, workTitle } from './guided.ts';
import { NextSchema } from './guided-schema.ts';
import { actionCard } from './card.ts';
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
  let activity = 0;
  let approvalOpen = false;
  let inputVersion = 0;
  let latestInput: { text: string; source: 'interactive' | 'rpc' } | undefined;
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
    latestInput = undefined;
    inputVersion++;
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
  pi.on('session_shutdown', () => { epoch++; latestInput = undefined; inputVersion++; inFlight.clear(); });
  pi.on('input', event => {
    inputVersion++;
    latestInput = event.source === 'interactive' || event.source === 'rpc' ? { text: event.text, source: event.source } : undefined;
    return { action: 'continue' };
  });
  pi.on('tool_execution_start', (event, ctx) => {
    if (!['mentor_status', 'mentor_record', 'mentor_next', 'mentor_assist'].includes(event.toolName)) { inFlight.add(event.toolCallId); activity++; }
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
            const next = transition(state, proposal, observation);
            const feedback = operationFeedback(state, next, proposal);
            persist(next, ctx);
            ctx.ui.notify(feedback, 'info');
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
    description: 'Read Mentor current state and complete version/critique/response/judgment history on the active branch. Returns latest snapshot for mentor_record. Read-only; works while paused. User controls progression through /mentor cards or a one-time native approval of a typed mentor_assist card operation; ordinary chat never authorizes progression.',
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
    description: 'Prepare ONE current-artifact/next-action card from the conversation. Does NOT select an edge, change phase, adopt, authorize implementation or accept anything. Call after recording critiques/evidence: later state or source changes make the card stale. Provide a concise summary, unresolved matters and the exact typed edge payload. Only the user can apply it through /mentor by selecting the returned action label (summary is NOT the label); that selection applies immediately, with NO later confirmation dialog; all necessary records and movement commit atomically. goals stores goal+constraints; issue creates/selects an exact issue; critique text sets the exact review target (not adoption); decide opens the direction discussion; adopt records provisional adoption and opens scope discussion (not implementation); scope records a new feature/experiment scope without starting; start confirms the exact contract and explicitly starts ONLY that unit; inspect stops implementation for inspection; accept binds the displayed contract/source/evidence/limitations; correct explicitly restarts implementation within the current contract; design/revise/defer/review/finish are explicit loops or whole review. Use scope for experiments without inferring design adoption. No free-form action labels, user actions, automatic transitions or grading. Require the latest snapshot.',
    parameters: Type.Object({ expectedSnapshot: Type.String(), proposal: NextSchema }, { additionalProperties: false }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async execute(_id, params, signal, _update, ctx) {
      try {
        if (signal?.aborted) throw new Error('Mentor next-action draft cancelled.');
        check(params.expectedSnapshot, ctx);
        persist(proposeNext(state, params.proposal, observation), ctx);
        const data = { ...result(), operationStatus: 'proposed', ...actionMeaning(params.proposal.edge, state), interaction: 'Select the actual action label in /mentor to apply immediately. No extra confirmation follows. Summary is not the label.' };
        return { content: [{ type: 'text', text: JSON.stringify(data) }], details: data, structuredContent: JSON.parse(JSON.stringify(data)) };
      } catch (failure) {
        const data = { ...result(), operationError: failure instanceof Error ? failure.message : String(failure) };
        return { content: [{ type: 'text', text: JSON.stringify(data) }], details: data, structuredContent: JSON.parse(JSON.stringify(data)), isError: true };
      }
    },
  });
  pi.registerTool({
    name: 'mentor_assist', label: 'Mentor one-time card approval', exposure: 'model-only',
    description: 'Only on an explicit user request for a Mentor card operation or flow assistance, propose ONE typed normal card operation and ask for native one-time approval of its exact content and consequences. Every domain-valid edge in the proposal schema is eligible, with the same preconditions and authority as selecting that normal /mentor card. Do not call for acknowledgement, ordinary questions or quoted requests. Host-observed input is context, NOT consent; only affirmative native approval authorizes this exact operation. No /mentor phase/revision forms needed. Do not retry cancelled/rejected approval without a fresh explicit user request. Adoption is not implementation permission; start/correct authorize only the displayed exact contract; acceptance binds displayed contract/source/evidence/missing evidence/limitations, never starts another unit or adopts an experiment as a design. No advanced reset/pause, arbitrary action arrays, blanket delegation or automatic follow-up. Cancel/stale/noUI/paused/other tool activity apply nothing. Requires latest snapshot. TUI only. Returns actual label, effect and applied/cancelled/rejected status; never claim a proposal was applied.',
    parameters: Type.Object({ expectedSnapshot: Type.String(), proposal: NextSchema }, { additionalProperties: false }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async execute(_id, params, signal, _update, ctx) {
      let ownsApproval = false;
      try {
        if (!ctx.hasUI || ctx.mode !== 'tui') throw new Error('Native Mentor approval requires interactive TUI; no change applied.');
        if (approvalOpen || inFlight.size) throw new Error('Mentor approval or other tool activity is busy; no change applied.');
        if (signal?.aborted) throw new Error('Mentor assistance cancelled; no change applied.');
        check(params.expectedSnapshot, ctx);
        if (!latestInput) throw new Error('No host-observed real user input for this request; no change applied.');
        const proposal = structuredClone(params.proposal);
        const planned = transition(state, proposal, observation);
        const meaning = actionMeaning(proposal.edge, state);
        const feedback = operationFeedback(state, planned, proposal);
        const expected = token(), version = inputVersion, toolsVersion = activity, leaf = ctx.sessionManager.getLeafId();
        const request = structuredClone(latestInput);
        const body = `実際の直近入力 (${request.source}、依頼の文脈のみ・承認ではない):\n${request.text}\n\nセッション: ${sessionId}\n記録: ${state.sequence} / 枝の末尾: ${leaf ?? 'なし'}\n最終確認ソース: ${sourceIdentity(observation)}\n（最終確認時の一致のみ。原子的・ライブ監視ではありません）\n\n現在の相談: ${workTitle(state)}\n適用後の相談: ${workTitle(planned)}\n操作: ${meaning.label}\n選ぶと: ${meaning.effect}\n\n${exactArtifact(state, proposal, observation)}\n\n承認した場合の変更:\n${operationFeedback(state, planned, proposal, 'planned')}\n\n表示した内容の、この操作一回だけを承認します。通常の /mentor カードで同じ操作を選ぶ場合と同じ権限・変更です。後続の操作や次の単位の開始は承認しません。`;
        approvalOpen = true; ownsApproval = true;
        const choice = await actionCard(ctx, 'Mentor 操作の一回限りの承認', body, meaning.label, { signal });
        if (signal?.aborted) throw new Error('Mentor assistance cancelled; no change applied.');
        if (choice !== 'edge') {
          const data = { ...result(), operationStatus: 'cancelled', ...meaning };
          return { content: [{ type: 'text', text: JSON.stringify(data) }], details: data, structuredContent: JSON.parse(JSON.stringify(data)) };
        }
        check(expected, ctx);
        if (version !== inputVersion || toolsVersion !== activity || inFlight.size || leaf !== ctx.sessionManager.getLeafId()) throw new Error('Request, branch or tool activity changed during approval; no change applied.');
        persist(planned, ctx);
        ctx.ui.notify(feedback, 'info');
        const data = { ...result(), operationStatus: 'applied', ...meaning, feedback };
        return { content: [{ type: 'text', text: JSON.stringify(data) }], details: data, structuredContent: JSON.parse(JSON.stringify(data)) };
      } catch (failure) {
        const data = { ...result(), operationStatus: signal?.aborted ? 'cancelled' : 'rejected', operationError: failure instanceof Error ? failure.message : String(failure) };
        return { content: [{ type: 'text', text: JSON.stringify(data) }], details: data, structuredContent: JSON.parse(JSON.stringify(data)), isError: true };
      } finally {
        if (ownsApproval) approvalOpen = false;
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
