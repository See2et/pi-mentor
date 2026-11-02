import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { Type } from 'typebox';
import { DiscussionActionSchema, applyDiscussion, ModelActionSchema, applyModel, applyUser, initialState, mentorContext, restore, type ModelAction, type State, type UserAction } from './domain.ts';
import { mentorMenu } from './menu.ts';
import { guidedMenu, type GuidedOwner } from './guided-menu.ts';
import { actionMeaning, operationFeedback, exactArtifact, sourceIdentity, proposeNext, transition, workTitle } from './guided.ts';
import { NextSchema } from './guided-schema.ts';
import { actionCard } from './card.ts';
import { widgetLines } from './presentation.ts';
import { observeSource } from './source.ts';
import type { Observation } from './units.ts';
import { StatusSchema, statusView } from './status.ts';

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
  let declinedInputVersion: number | undefined;
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
    declinedInputVersion = undefined;
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
    if (!['mentor_status', 'mentor_record', 'mentor_next', 'mentor_assist', 'mentor_discuss'].includes(event.toolName)) { inFlight.add(event.toolCallId); activity++; }
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

  const namespace = { name: 'mentor', description: 'Mentor records and /mentor card drafts. Discover schemas with describeTool; serialize writes with the latest snapshot. Native approval uses mentor_assist, never scripts.' };
  const result = () => ({
    snapshot: token(), paused: !state.enabled, error, operationStatus: 'unchanged',
    sourceObservation: observation,
    location: { whole: state.whole, issueId: state.activeIssue, unitId: state.activeUnit },
    recovery: 'Read mentor_status via codemode for current state; refresh before retrying stale writes. Only /mentor can resume/reset.',
  });
  const recorded = (action: ModelAction) => {
    if (action.type === 'proposal') return { type: action.type, proposalId: state.proposals.at(-1)!.id };
    if ('issueId' in action) {
      const issue = state.issues.find(i => i.id === action.issueId)!;
      return { type: action.type, issueId: issue.id,
        revision: action.type === 'draft' ? issue.revisions.at(-1)!.revision : action.revision,
        critiqueId: action.type === 'critique' ? issue.critiques.at(-1)!.id : undefined,
        responseNumber: action.type === 'response' ? issue.responses.length : undefined };
    }
    const unit = action.unitId ? state.units.find(u => u.id === action.unitId)! : state.units.at(-1)!;
    return { type: action.type, unitId: unit.id,
      revision: action.type === 'unitDraft' ? unit.revisions.at(-1)!.revision : action.revision,
      evidenceId: action.type === 'unitEvidence' ? unit.evidence.at(-1)!.id : undefined,
      reportNumber: action.type === 'unitReport' ? unit.reports.length : undefined,
      noteNumber: action.type === 'unitSuggestion' ? unit.notes.length : undefined };
  };
  pi.registerTool({
    name: 'mentor_status', label: 'Mentor status', exposure: 'codemode', namespace,
    description: 'Read current summary (default), complete issue/unit by ID, or explicit full branch history. Includes omissions/recovery, exact source observation and latest snapshot. Read-only; works while paused. Human decisions require /mentor or native approval, never chat assent.',
    parameters: StatusSchema,
    outputSchema: Type.Object({ snapshot: Type.String(), paused: Type.Boolean(), record: Type.Optional(Type.Unknown()), operationError: Type.Optional(Type.String()) }, { additionalProperties: true }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    async execute(_id, params, _signal, _update, ctx) {
      try {
        checkContext(ctx);
        refresh(ctx); paint(ctx);
        const data = { ...result(), ...statusView(state, params, observation) };
        return { content: [{ type: 'text', text: JSON.stringify(data) }], details: data, structuredContent: JSON.parse(JSON.stringify(data)) };
      } catch (failure) {
        const data = { ...result(), operationError: failure instanceof Error ? failure.message : String(failure), recovery: 'Read mentor_status({}) via codemode to discover IDs; use view issue + issueId, unit + unitId, or full.' };
        return { content: [{ type: 'text', text: JSON.stringify(data) }], details: data, structuredContent: JSON.parse(JSON.stringify(data)), isError: true };
      }
    },
  });
  pi.registerTool({
    name: 'mentor_next', label: 'Mentor next-action draft', exposure: 'codemode', namespace,
    description: 'Draft ONE exact typed /mentor card; never apply its effects. Latest snapshot required; call last after records/evidence (state/source changes stale it). Include summary and unresolved matters. Only user selection of the returned label—not summary—applies atomically, with no later confirmation. adopt is direction only; scope does not start; start/correct authorize only the exact unit contract; accept binds contract/source/evidence/limitations, never starts work or adopts an experiment as design. No automatic transitions or grading.',
    parameters: Type.Object({ expectedSnapshot: Type.String(), proposal: NextSchema }, { additionalProperties: false }),
    outputSchema: Type.Object({ snapshot: Type.String() }, { additionalProperties: true }),
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
    description: 'Offer ONE exact normal-card operation at a human decision point or explicit operation/skip request; no internal-command request needed. TUI native affirmative approval alone authorizes it, with the same preconditions/authority as /mentor. Chat, host input and quotes are context, NOT consent. Never retry cancelled/rejected approval without fresh explicit user intent. Latest snapshot required; call last after records. adopt does not start; start/correct authorize only displayed contract; accept binds contract/source/evidence/missing evidence/limitations, never next work or experiment design adoption. No advanced reset/pause, arrays, delegation or automatic follow-up. Cancel/stale/noUI/paused/busy apply nothing. Report actual applied/cancelled/rejected status.',
    parameters: Type.Object({ expectedSnapshot: Type.String(), proposal: NextSchema }, { additionalProperties: false }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async execute(_id, params, signal, _update, ctx) {
      let ownsApproval = false;
      let approvalInputVersion: number | undefined;
      try {
        if (!ctx.hasUI || ctx.mode !== 'tui') throw new Error('Native Mentor approval requires interactive TUI; no change applied.');
        if (approvalOpen || inFlight.size) throw new Error('Mentor approval or other tool activity is busy; no change applied.');
        if (signal?.aborted) throw new Error('Mentor assistance cancelled; no change applied.');
        check(params.expectedSnapshot, ctx);
        if (!latestInput) throw new Error('No host-observed real user input for this request; no change applied.');
        if (declinedInputVersion === inputVersion) throw new Error('Mentor approval was cancelled or rejected on this input. Wait for fresh explicit user intent before offering it again.');
        const proposal = structuredClone(params.proposal);
        const planned = transition(state, proposal, observation);
        const meaning = actionMeaning(proposal.edge, state);
        const feedback = operationFeedback(state, planned, proposal);
        const expected = token(), version = inputVersion, toolsVersion = activity, leaf = ctx.sessionManager.getLeafId();
        const request = structuredClone(latestInput);
        const body = `実際の直近入力 (${request.source}、依頼の文脈のみ・承認ではない):\n${request.text}\n\nセッション: ${sessionId}\n記録: ${state.sequence} / 枝の末尾: ${leaf ?? 'なし'}\n最終確認ソース: ${sourceIdentity(observation)}\n（最終確認時の一致のみ。原子的・ライブ監視ではありません）\n\n現在の相談: ${workTitle(state)}\n適用後の相談: ${workTitle(planned)}\n操作: ${meaning.label}\n選ぶと: ${meaning.effect}\n\n${exactArtifact(state, proposal, observation)}\n\n承認した場合の変更:\n${operationFeedback(state, planned, proposal, 'planned')}\n\n表示した内容の、この操作一回だけを承認します。通常の /mentor カードで同じ操作を選ぶ場合と同じ権限・変更です。後続の操作や次の単位の開始は承認しません。`;
        approvalOpen = true; ownsApproval = true; approvalInputVersion = version;
        const choice = await actionCard(ctx, 'Mentor 操作の一回限りの承認', body, meaning.label, { signal });
        if (signal?.aborted) throw new Error('Mentor assistance cancelled; no change applied.');
        if (choice !== 'edge') {
          declinedInputVersion = version;
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
        if (ownsApproval) declinedInputVersion = approvalInputVersion;
        const data = { ...result(), operationStatus: signal?.aborted ? 'cancelled' : 'rejected', operationError: failure instanceof Error ? failure.message : String(failure) };
        return { content: [{ type: 'text', text: JSON.stringify(data) }], details: data, structuredContent: JSON.parse(JSON.stringify(data)), isError: true };
      } finally {
        if (ownsApproval) approvalOpen = false;
      }
    },
  });
  pi.registerTool({
    name: 'mentor_discuss', label: 'Mentor discussion update',
    description: 'Organize actual conversation with brief disclosure: goals->issues, new issue->hypothesis, exact unconfirmed target->critique, critique->direction, or rethink. Ask concrete stage questions and address answers first; no stage-racing, grading or AI-chosen skips. Never confirms/adopts, authorizes scope/start, switches units, accepts or leaves implementation. Changed targets remain unconfirmed; history stays revision-bound. Discover mentor_record/status/next via codemode describeTool; use mentor_assist for human decisions/skips. Latest snapshot required; paused rejects.',
    parameters: Type.Object({ expectedSnapshot: Type.String(), action: DiscussionActionSchema }, { additionalProperties: false }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async execute(_id, params, signal, _update, ctx) {
      try {
        if (signal?.aborted) throw new Error('Mentor discussion update cancelled.');
        check(params.expectedSnapshot, ctx);
        const next = applyDiscussion(state, params.action);
        const target = next.activeIssue === null ? undefined : next.issues.find(i => i.id === next.activeIssue);
        const revision = target?.revisions.find(r => r.revision === target.currentRevision);
        const title = workTitle(next).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 80);
        const feedback = `相談を整理: ${title}${params.action.type === 'target' ? ` · 検討対象 r${revision!.revision}（${revision!.confirmed ? '本人確認済みの案を維持' : 'AI整理・未確認'}）` : ''}。採用・実装許可・受け入れは変更していません。`;
        persist(next, ctx);
        if (ctx.hasUI) ctx.ui.notify(feedback, 'info');
        const data = { ...result(), operationStatus: 'discussion-updated', feedback };
        return { content: [{ type: 'text', text: JSON.stringify(data) }], details: data, structuredContent: JSON.parse(JSON.stringify(data)) };
      } catch (failure) {
        const data = { ...result(), operationError: failure instanceof Error ? failure.message : String(failure) };
        return { content: [{ type: 'text', text: JSON.stringify(data) }], details: data, structuredContent: JSON.parse(JSON.stringify(data)), isError: true };
      }
    },
  });
  pi.registerTool({
    name: 'mentor_record', label: 'Mentor record / propose', exposure: 'codemode', namespace,
    description: 'Record AI drafts/proposals, grounded revision-bound critiques/corrections, reported responses, unit contracts/evidence/readiness or optional learning prompts. Never changes phase, selection, human confirmation/judgment or understanding. Exact latest snapshot required; serialize writes, refresh conflicts; paused rejects. Critique corrections reference SAME revision and preserve history; responses are AI reports. Evidence requires valid expectation IDs, exact current contract revision and sourceHash actually observed by mentor_status (rechecked at commit); include observations, references/commands/results, real/substitute/untested methods, limitations and concerns. Passing tests is not expectation satisfaction. Drafts do not authorize implementation.',
    parameters: Type.Object({ expectedSnapshot: Type.String(), action: ModelActionSchema }, { additionalProperties: false }),
    outputSchema: Type.Object({ snapshot: Type.String(), paused: Type.Boolean(), operationStatus: Type.Optional(Type.String()), operationError: Type.Optional(Type.String()) }, { additionalProperties: true }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async execute(_id, params, signal, _update, ctx) {
      try {
        if (signal?.aborted) throw new Error('Mentor record cancelled.');
        check(params.expectedSnapshot, ctx);
        persist(applyModel(state, params.action, observation), ctx);
        const data = { ...result(), operationStatus: 'recorded', recorded: recorded(params.action) };
        return { content: [{ type: 'text', text: JSON.stringify(data) }], details: data, structuredContent: JSON.parse(JSON.stringify(data)) };
      } catch (failure) {
        const data = { ...result(), operationError: failure instanceof Error ? failure.message : String(failure) };
        return { content: [{ type: 'text', text: JSON.stringify(data) }], details: data, structuredContent: JSON.parse(JSON.stringify(data)), isError: true };
      }
    },
  });
}
