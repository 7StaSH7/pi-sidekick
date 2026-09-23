import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { getAgentDir, getPackageDir, SessionManager, truncateHead, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { Text } from '@earendil-works/pi-tui';
import { callText, resultText } from './presentation.mjs';
import { RpcPeer } from './rpc.mjs';
import { loadFusionConfig, saveFusionConfig } from './config.mjs';
import { formatStats, formatTaskCost, makeDelegationRecord, snapshotModel } from './cost.mjs';
import { DEFAULT_TIMEOUT_MINUTES, STATE, STATS, TOOL, WORKER_ENV, WORKER_CONFIG_ENV, WORKER_TOOLS, LEAD_PROMPT, assertModel, requireModel, restoreState, hasSidekickSibling, inheritedExtensions, parseLaunchSidekick, sidekickPrompt, displaySidekick, validateSidekickSelection, defaultFusionConfig, timeoutMilliseconds, validateTimeoutMinutes } from './policy.mjs';
import { applyActivityEvent, createActivityState, formatActivity, startActivityAnimation } from './activity.mjs';

const entryPath = fileURLToPath(import.meta.url);

type Checkpoint = { file: string; leaf: string | null; owner: string };
type State = { enabled: boolean; checkpoint?: Checkpoint };

function workerExtension(pi: ExtensionAPI) {
  let expected;
  let launchError;
  try {
    expected = parseLaunchSidekick(process.env[WORKER_CONFIG_ENV] ?? '');
  } catch (error) {
    launchError = error;
  }
  const guard = (ctx: ExtensionContext) => {
    if (launchError) throw launchError;
    requireModel(ctx.modelRegistry, expected, getSupportedThinkingLevels);
    assertModel(ctx.model, expected, pi.getThinkingLevel());
  };
  pi.on('input', (_event, ctx) => {
    try {
      guard(ctx);
    } catch (error) {
      ctx.ui.notify(`Fusion blocked: ${String(error)}`, 'error');
      return { action: 'handled' };
    }
    pi.setActiveTools(WORKER_TOOLS);
  });
  pi.on('before_agent_start', event => ({ systemPrompt: event.systemPrompt + sidekickPrompt(expected) }));
  pi.on('tool_call', (event, ctx) => {
    guard(ctx);
    if (!WORKER_TOOLS.includes(event.toolName)) {
      return { block: true, reason: 'Fusion sidekick cannot use delegation or non-allowlisted tools.', terminate: true };
    }
  });
}

export default function fusion(pi: ExtensionAPI) {
  // The child gets native pi hooks and overrides, but never another Fusion lead.
  if (process.env[WORKER_ENV] === '1') {
    workerExtension(pi);
    return;
  }

  let state: State = { enabled: false };
  let config = defaultFusionConfig();
  let startupFailure: string | undefined;
  let peer: RpcPeer | undefined;
  let childFile: string | undefined;
  let busy = false;
  let disposed = false;
  let activeContext: ExtensionContext | undefined;
  let uiSignal: AbortSignal | undefined;
  let lastAssistant: any;
  let taskError: string | undefined;
  let onProgress: ((text: string) => void) | undefined;
  let activity: ReturnType<typeof createActivityState> | undefined;
  let lastActivityText: string | undefined;
  let animationFrame: number | undefined;
  let stopAnimation: (() => void) | undefined;
  let usage: any;
  let usageCostReported = false;
  let usageCall: string | undefined;

  function status(ctx: ExtensionContext) {
    const text = state.enabled
      ? `Fusion · ${displaySidekick(config.sidekick)}${busy ? ' · working' : ''}`
      : startupFailure ? 'Fusion · startup error · /fusion setup, on or off' : undefined;
    ctx.ui.setStatus('fusion', text);
  }
  function blockStartup(ctx: ExtensionContext, error: unknown) {
    startupFailure = String(error);
    state = { ...state, enabled: false };
    tools();
    status(ctx);
    ctx.ui.notify(`Fusion startup failed: ${startupFailure}. Input is blocked; use /fusion setup, /fusion on or /fusion off.`, 'error');
  }
  function save(ctx: ExtensionContext) {
    pi.appendEntry(STATE, state);
    status(ctx);
  }
  function tools() {
    const active = pi.getActiveTools().filter(name => name !== TOOL);
    pi.setActiveTools(state.enabled ? [...active, TOOL] : active);
  }
  async function stop() {
    const current = peer;
    peer = undefined;
    await current?.close();
  }
  function root() {
    const path = join(getAgentDir(), 'fusion', 'sessions');
    mkdirSync(path, { recursive: true, mode: 0o700 });
    return realpathSync(path);
  }
  function checkedFile(file: string) {
    const base = root();
    if (!file.endsWith('.jsonl') || !existsSync(file) || !realpathSync(file).startsWith(base + sep)) {
      throw new Error('Fusion checkpoint is missing or outside its session directory. Use /fusion reset to start a new sidekick.');
    }
    return realpathSync(file);
  }
  function resumeFile(ctx: ExtensionContext) {
    const checkpoint = state.checkpoint;
    if (!checkpoint) return undefined;
    const file = checkedFile(checkpoint.file);
    const sm = SessionManager.open(file, root());
    if (resolve(sm.getCwd()) !== resolve(ctx.cwd)) throw new Error('Fusion checkpoint belongs to a different working directory.');
    if (checkpoint.owner === ctx.sessionManager.getSessionId() && sm.getLeafId() === checkpoint.leaf) return file;
    // A fork or /tree rewind must not inherit the sidekick's abandoned future.
    if (checkpoint.leaf === null) return undefined;
    if (!sm.getEntry(checkpoint.leaf)) throw new Error('Fusion checkpoint entry is missing.');
    return sm.createBranchedSession(checkpoint.leaf);
  }
  function checkpoint(ctx: ExtensionContext) {
    if (disposed || !childFile || !existsSync(childFile)) return;
    const sm = SessionManager.open(checkedFile(childFile), root());
    state = { ...state, checkpoint: { file: childFile, leaf: sm.getLeafId(), owner: ctx.sessionManager.getSessionId() } };
    if (!disposed) save(ctx);
  }

  async function ui(request: any) {
    const ctx = activeContext;
    if (!ctx) return { cancelled: true };
    const title = `Fusion sidekick · ${displaySidekick(config.sidekick)} · ${request.title ?? ''}`;
    const options = { signal: uiSignal, ...(request.timeout ? { timeout: request.timeout } : {}) };
    if (request.method === 'notify') {
      if (request.message?.startsWith('Fusion blocked:')) {
        taskError = request.message;
        void peer?.close();
      }
      if (ctx.hasUI) ctx.ui.notify(`Fusion sidekick: ${request.message}`, request.notifyType ?? 'info');
      return;
    }
    if (!ctx.hasUI || uiSignal?.aborted) return { cancelled: true };
    switch (request.method) {
      case 'confirm': return { confirmed: await ctx.ui.confirm(title, request.message ?? '', options) };
      case 'select': {
        const value = await ctx.ui.select(title, request.options, options);
        return value === undefined ? { cancelled: true } : { value };
      }
      case 'input': {
        const value = await ctx.ui.input(title, request.placeholder, options);
        return value === undefined ? { cancelled: true } : { value };
      }
      // Multiline editors have no abort contract; deny rather than hanging cancellation.
      case 'editor': return { cancelled: true };
    }
    // Do not let child extensions overwrite the lead's editor, title or footer.
  }

  function reportActivity() {
    if (!activity) return;
    const text = formatActivity(activity, animationFrame);
    if (text === lastActivityText) return;
    lastActivityText = text;
    onProgress?.(text);
  }
  function event(event: any) {
    if (event.type === 'extension_error') taskError = `Sidekick extension error (${event.event ?? 'unknown event'}). Inspect its session before retrying.`;
    if (activity && applyActivityEvent(activity, event)) reportActivity();
    if (event.type === 'message_end' && event.message?.role === 'assistant') {
      lastAssistant = event.message;
      addUsage(event.message.usage);
    }
    if (event.type === 'compaction_end') addUsage(event.result?.usage);
  }
  function addUsage(value: any) {
    if (!value || !usage) return;
    const consumed = ['input', 'output', 'cacheRead', 'cacheWrite'].some(key => (value[key] ?? 0) > 0);
    if (consumed && !(typeof value.cost?.total === 'number' && Number.isFinite(value.cost.total) && value.cost.total > 0)) usageCostReported = false;
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']) usage[key] += value[key] ?? 0;
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total']) usage.cost[key] += value.cost?.[key] ?? 0;
  }

  async function start(ctx: ExtensionContext) {
    if (peer?.alive) return peer;
    await stop();
    childFile = undefined;
    const expected = validateSidekickSelection(config.sidekick);
    requireModel(ctx.modelRegistry, expected, getSupportedThinkingLevels);
    const file = resumeFile(ctx);
    const packageDir = getPackageDir();
    const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
    const rpcEntry = resolve(packageDir, manifest.exports['./rpc-entry'].import);
    const args = [rpcEntry, '--mode', 'rpc', '--provider', expected.provider, '--model', expected.id,
      '--thinking', expected.thinking, '--models', `${expected.provider}/${expected.id}:${expected.thinking}`,
      '--tools', WORKER_TOOLS.join(','), '--session-dir', root(),
      ...(file ? ['--session', file] : ['--session-id', randomUUID()]),
      ctx.isProjectTrusted() ? '--approve' : '--no-approve',
      ...inheritedExtensions(process.argv.slice(2), process.cwd()), '-e', entryPath];
    peer = new RpcPeer(process.execPath, args, {
      cwd: ctx.cwd,
      env: { ...process.env, [WORKER_ENV]: '1', [WORKER_CONFIG_ENV]: JSON.stringify(expected) },
      onEvent: event,
      onUi: ui,
    });
    const child = await peer.request('get_state');
    assertModel(child.model, expected, child.thinkingLevel);
    if (typeof child.sessionFile !== 'string' || dirname(resolve(child.sessionFile)) !== root()) {
      throw new Error('Sidekick did not create a private Fusion session.');
    }
    childFile = child.sessionFile;
    return peer;
  }

  pi.registerTool({
    name: TOOL,
    label: 'Fusion · sidekick',
    description: 'Delegate a bounded task to the persistent configured OpenAI sidekick. Call alone, never alongside other tools. Supply a self-contained brief, constraints and success criteria. Returns its report (at most 2000 lines / 50KB) and session location. The lead must review actual changes. Fails rather than switching models.',
    promptSnippet: 'Delegate implementation or scoped exploration to the configured sidekick',
    renderCall(args, theme, context) {
      return new Text(callText(args, context.expanded, theme), 0, 0);
    },
    renderResult(result, options, theme, context) {
      return new Text(resultText(result, { ...options, isError: context.isError }, theme), 0, 0);
    },
    parameters: Type.Object({
      brief: Type.String({ minLength: 1, maxLength: 32000, description: 'Task and relevant facts/paths; no full conversation dump.' }),
      constraints: Type.String({ minLength: 1, maxLength: 8000, description: 'Scope, restrictions, relevant user instructions.' }),
      success_criteria: Type.String({ minLength: 1, maxLength: 8000, description: 'Observable acceptance checks, tests and expected result.' }),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      if (!state.enabled) throw new Error('Fusion is off. Enable it with /fusion on.');
      if (!ctx.isProjectTrusted()) throw new Error('Fusion sidekick requires a trusted project.');
      const selected = validateSidekickSelection(config.sidekick);
      const timeoutMinutes = validateTimeoutMinutes(config.timeoutMinutes);
      const taskTimeoutMs = timeoutMilliseconds(timeoutMinutes);
      const sidekickModel = requireModel(ctx.modelRegistry, selected, getSupportedThinkingLevels);
      const leadSnapshot = snapshotModel(ctx.model);
      const sidekickSnapshot = snapshotModel(sidekickModel);
      if (busy) throw new Error('Only one Fusion task may run at a time.');
      signal?.throwIfAborted();
      busy = true;
      activeContext = ctx;
      lastAssistant = undefined;
      taskError = undefined;
      activity = createActivityState(displaySidekick(selected));
      lastActivityText = undefined;
      usageCall = _id;
      usageCostReported = true;
      usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
      let outcome: 'success' | 'error' | 'cancelled' = 'error';
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(new Error(`Fusion task exceeded ${timeoutMinutes} minutes.`)), taskTimeoutMs);
      const cancel = () => controller.abort(signal?.reason);
      signal?.addEventListener('abort', cancel, { once: true });
      uiSignal = controller.signal;
      // Abort native pi first so its tools can clean up; close() is the bounded fallback.
      let abortWork: Promise<unknown> | undefined;
      const abort = () => {
        const current = peer;
        if (current && !abortWork) {
          abortWork = current.request('abort', {}, 3000).catch(() => current.close());
          void abortWork.catch(() => {});
        }
      };
      controller.signal.addEventListener('abort', abort, { once: true });
      onProgress = text => {
        onUpdate?.({ content: [{ type: 'text', text }], details: {} });
      };
      const animate = ctx.hasUI && !!onUpdate;
      animationFrame = animate ? 0 : undefined;
      try {
        status(ctx);
        reportActivity();
        stopAnimation = animate ? startActivityAnimation(frame => {
          animationFrame = frame;
          reportActivity();
        }, controller.signal) : undefined;
        const current = await start(ctx);
        controller.signal.throwIfAborted();
        if (taskError) throw new Error(taskError);
        const child = await current.request('get_state');
        controller.signal.throwIfAborted();
        assertModel(child.model, selected, child.thinkingLevel);
        const settled = current.waitForEvent(e => e.type === 'agent_settled', { signal: controller.signal, timeoutMs: taskTimeoutMs });
        // Attach a rejection handler before sending: cancellation can win the acceptance race.
        void settled.catch(() => {});
        await current.request('prompt', { message: `Fusion brief\n\n${params.brief}\n\nConstraints\n${params.constraints}\n\nSuccess criteria\n${params.success_criteria}` });
        await settled;
        controller.signal.throwIfAborted();
        if (taskError) throw new Error(taskError);
        if (!lastAssistant || lastAssistant.stopReason !== 'stop') {
          throw new Error(`Fusion sidekick did not finish successfully (${lastAssistant?.stopReason ?? 'no final answer'}). Changes may be partial; inspect the saved session.`);
        }
        const text = lastAssistant.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
        if (!text.trim()) throw new Error('Fusion sidekick returned no report. Inspect its saved session before retrying.');
        const output = truncateHead(text);
        outcome = 'success';
        const costRecord = makeDelegationRecord(_id, leadSnapshot, sidekickSnapshot, { ...usage, costReported: usageCostReported }, outcome);
        return {
          content: [{ type: 'text', text: `${output.content}\n\n${formatTaskCost(costRecord)}\n\n${output.truncated ? '[Report truncated.] ' : ''}Sidekick session: ${childFile}\nLead: verify the actual diff and checks before declaring completion.` }],
          details: { sessionFile: childFile, provider: selected.provider, model: selected.id, thinking: selected.thinking, costRecord },
          usage,
        };
      } catch (error) {
        outcome = controller.signal.aborted ? 'cancelled' : 'error';
        stopAnimation?.();
        abort();
        await abortWork?.catch(() => {});
        await stop();
        throw new Error(`${controller.signal.aborted ? String(controller.signal.reason ?? 'Cancelled') : String(error)}${childFile ? ` Saved session: ${childFile}.` : ''} Sidekick may have changed files; cancellation does not roll them back.`);
      } finally {
        stopAnimation?.();
        stopAnimation = undefined;
        animationFrame = undefined;
        clearTimeout(deadline);
        signal?.removeEventListener('abort', cancel);
        controller.signal.removeEventListener('abort', abort);
        controller.abort(); // Close permission dialogs even if the worker crashed.
        try {
          if (!disposed) pi.appendEntry(STATS, makeDelegationRecord(_id, leadSnapshot, sidekickSnapshot, { ...usage, costReported: usageCostReported }, outcome));
        } finally {
          try { checkpoint(ctx); }
          finally {
            busy = false;
            onProgress = undefined;
            activity = undefined;
            lastActivityText = undefined;
            activeContext = undefined;
            uiSignal = undefined;
            if (!disposed) status(ctx);
          }
        }
      }
    },
  });

  async function enable(ctx: ExtensionContext) {
    if (!ctx.isProjectTrusted()) throw new Error('Fusion requires a trusted project.');
    requireModel(ctx.modelRegistry, config.sidekick, getSupportedThinkingLevels);
    state = { ...state, enabled: true };
    startupFailure = undefined;
    save(ctx);
    tools();
  }
  async function setup(ctx: ExtensionContext) {
    if (!ctx.isProjectTrusted()) throw new Error('Fusion requires a trusted project.');
    if (!ctx.hasUI) throw new Error('Fusion setup requires native select UI.');
    const selectCurrent = async (title: string, choices: string[], current?: string) => {
      const ordered = [...choices].sort((a, b) => Number(b === current) - Number(a === current));
      const labels = ordered.map(value => value === current ? `${value} (Current)` : value);
      const choice = await ctx.ui.select(title, labels, { signal: ctx.signal });
      if (choice === undefined) throw new Error('Fusion setup cancelled; existing settings were kept.');
      const index = labels.indexOf(choice);
      if (index < 0) throw new Error('Fusion setup returned an unknown choice.');
      return ordered[index];
    };
    const models = ctx.modelRegistry.getAvailable()
      .filter(model => ['openai-codex', 'openai'].includes(model.provider) && ctx.modelRegistry.hasConfiguredAuth(model))
      .sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`));
    if (models.length === 0) throw new Error('No authenticated openai-codex/openai sidekick models are available. Configure /login first.');
    const modelChoices = models.map(model => `${model.provider}/${model.id}${model.name && model.name !== model.id ? ` · ${model.name}` : ''}`);
    const currentModelIndex = models.findIndex(model => model.provider === config.sidekick.provider && model.id === config.sidekick.id);
    const modelChoice = await selectCurrent(
      `Fusion setup · sidekick model\nCurrent: ${displaySidekick(config.sidekick)} · ${config.timeoutMinutes} minutes`,
      modelChoices, modelChoices[currentModelIndex],
    );
    const modelIndex = modelChoices.indexOf(modelChoice);
    if (modelIndex < 0) throw new Error('Fusion setup returned an unknown model choice.');
    const model = models[modelIndex];
    const levels = getSupportedThinkingLevels(model);
    const thinking = await selectCurrent(`Fusion setup · reasoning · ${model.provider}/${model.id}`, levels, config.sidekick.thinking);
    if (!levels.includes(thinking)) throw new Error('Unsupported reasoning selection.');
    const selected = validateSidekickSelection({ provider: model.provider, id: model.id, thinking });
    const timeoutValues = [...new Set([15, 30, DEFAULT_TIMEOUT_MINUTES, 120, 240, config.timeoutMinutes])].sort((a, b) => a - b);
    const timeoutChoices = timeoutValues.map(minutes => `${minutes} minutes`);
    const timeoutChoice = await selectCurrent('Fusion setup · task timeout', timeoutChoices, `${config.timeoutMinutes} minutes`);
    const timeoutIndex = timeoutChoices.indexOf(timeoutChoice);
    if (timeoutIndex < 0) throw new Error('Fusion setup returned an unknown timeout choice.');
    const next = { sidekick: selected, timeoutMinutes: validateTimeoutMinutes(timeoutValues[timeoutIndex]) };
    await stop();
    config = saveFusionConfig(getAgentDir(), next);
    startupFailure = undefined;
    state = { ...state, enabled: true };
    save(ctx);
    tools();
    status(ctx);
    ctx.ui.notify(`Fusion setup saved: ${displaySidekick(config.sidekick)} · timeout ${config.timeoutMinutes} minutes.`, 'info');
  }
  async function restoreOrEnable(ctx: ExtensionContext) {
    try {
      config = loadFusionConfig(getAgentDir());
      const restored = restoreState(ctx.sessionManager.getBranch());
      startupFailure = undefined;
      if (restored) {
        state = restored;
        if (state.enabled) requireModel(ctx.modelRegistry, config.sidekick, getSupportedThinkingLevels);
        tools();
        status(ctx);
        return;
      }
      state = { enabled: false };
      tools();
      status(ctx);
      await enable(ctx);
    } catch (error) {
      blockStartup(ctx, error);
    }
  }
  pi.registerCommand('fusion', {
    description: 'Fusion: on | off | setup | stats | status | reset',
    getArgumentCompletions: prefix => ['on', 'off', 'setup', 'stats', 'status', 'reset'].filter(x => x.startsWith(prefix)).map(x => ({ value: x, label: x })),
    handler: async (args, ctx) => {
      const command = args.trim() || 'status';
      if (busy && command !== 'status' && command !== 'stats') {
        ctx.ui.notify(`${displaySidekick(config.sidekick)} is working. Press Esc, then retry the command.`, 'warning');
        return;
      }
      try {
        if (command === 'on') await enable(ctx);
        else if (command === 'setup') { await setup(ctx); return; }
        else if (command === 'stats') {
          const records = ctx.sessionManager.getBranch().filter(entry => entry.type === 'custom' && entry.customType === STATS).map(entry => entry.data);
          ctx.ui.notify(formatStats(records), 'info');
          return;
        }
        else if (command === 'off') {
          await stop();
          startupFailure = undefined;
          state = { ...state, enabled: false };
          save(ctx);
          tools();
        } else if (command === 'reset') {
          if (startupFailure) throw new Error('Fusion startup failed; use /fusion setup or /fusion on to retry, or /fusion off to disable.');
          await stop();
          state = { enabled: state.enabled };
          save(ctx);
        } else if (command !== 'status') throw new Error('Use /fusion on | off | setup | stats | status | reset');
        ctx.ui.notify(`Fusion ${state.enabled ? 'ON' : 'OFF'} · ${displaySidekick(config.sidekick)} · timeout ${config.timeoutMinutes} minutes${busy ? ' · working' : ''}\n${state.checkpoint?.file ?? 'Sidekick session will appear on the first task.'}`, 'info');
      } catch (error) {
        if (command === 'on') blockStartup(ctx, error);
        else ctx.ui.notify(String(error), 'error');
      }
    },
  });
  pi.on('input', (_event, ctx) => {
    if (startupFailure) return { action: 'handled' };
    if (!state.enabled) return;
    try {
      requireModel(ctx.modelRegistry, config.sidekick, getSupportedThinkingLevels);
    } catch (error) {
      ctx.ui.notify(`${String(error)} Use /fusion setup, /fusion on or /fusion off.`, 'error');
      return { action: 'handled' };
    }
  });
  pi.on('before_agent_start', event => state.enabled ? { systemPrompt: event.systemPrompt + LEAD_PROMPT } : undefined);
  pi.on('tool_result', event => {
    if (event.toolName !== TOOL || event.toolCallId !== usageCall) return;
    const completedUsage = usage;
    usageCall = undefined;
    usage = undefined;
    return { usage: completedUsage };
  });
  pi.on('tool_call', (event, ctx) => {
    if (state.enabled && hasSidekickSibling(ctx.sessionManager.getBranch(), event.toolName)) {
      return { block: true, reason: 'Call fusion_sidekick alone; concurrent lead tools could race with sidekick edits.' };
    }
  });
  pi.on('session_start', async (_event, ctx) => {
    disposed = false;
    await restoreOrEnable(ctx);
  });
  pi.on('session_before_tree', (_event, ctx) => {
    if (busy) { ctx.ui.notify('Cancel the sidekick before navigating history.', 'warning'); return { cancel: true }; }
  });
  pi.on('session_tree', async (_event, ctx) => {
    await stop();
    await restoreOrEnable(ctx);
  });
  pi.on('session_shutdown', async (_event, ctx) => {
    disposed = true;
    stopAnimation?.();
    await stop();
    ctx.ui.setStatus('fusion', undefined);
  });
}
