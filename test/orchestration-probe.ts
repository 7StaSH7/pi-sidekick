import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Type } from 'typebox';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { STATE, STATS, TOOL, WORKER_ENV } from '../policy.mjs';

const LEAD = { provider: 'anthropic', id: 'fixture-lead', thinking: 'medium' };
const SIDEKICK = { provider: 'openai-codex', id: 'gpt-5.6-luna', thinking: 'max' };
const fixturePath = fileURLToPath(new URL('./fixture.ts', import.meta.url));
const probePath = fileURLToPath(import.meta.url);
const sidekickPath = fileURLToPath(new URL('../index.ts', import.meta.url));

function nativeResults(manager: SessionManager) {
  return manager.getBranch()
    .filter(entry => entry.type === 'message' && entry.message.role === 'toolResult'
      && ['Agent', 'SubagentWorkflow'].includes(entry.message.toolName))
    .map(entry => ({
      name: entry.message.toolName,
      isError: entry.message.isError === true,
      text: entry.message.content.filter(part => part.type === 'text').map(part => part.text).join('\n'),
    }));
}

function checkpoint(manager: SessionManager) {
  const entry = manager.getBranch().findLast(item => item.type === 'custom' && item.customType === STATE);
  return entry?.data?.checkpoint;
}

function waitForAction(session: any, command: string) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for Sidekick action: ${command}`));
    }, 30000);
    const unsubscribe = session.subscribe((event: any) => {
      if (event.type !== 'tool_execution_update' || event.toolName !== TOOL
        || !JSON.stringify(event.partialResult).includes(command)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    });
  });
}

async function createLead(cwd: string, trusted: boolean) {
  const agentDir = process.env.PI_CODING_AGENT_DIR!;
  const settingsManager = SettingsManager.inMemory({
    defaultProvider: LEAD.provider,
    defaultModel: LEAD.id,
    defaultThinkingLevel: LEAD.thinking,
    retry: { enabled: false },
    compaction: { enabled: false },
  }, { projectTrusted: trusted });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: join(agentDir, 'models.json'),
    refreshOnCreate: false,
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths: [fixturePath, probePath, sidekickPath],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  const sessionManager = SessionManager.inMemory(cwd);
  if (!trusted) sessionManager.appendCustomEntry(STATE, { enabled: true });
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    settingsManager,
    sessionManager,
    resourceLoader,
  });
  const notifications: string[] = [];
  const uiContext = {
    select: async () => undefined,
    confirm: async () => false,
    input: async () => undefined,
    notify: (message: string) => notifications.push(message),
    setStatus: () => {},
  } as any;
  await session.bindExtensions({ mode: 'rpc', uiContext });
  const model = modelRuntime.getModel(LEAD.provider, LEAD.id);
  if (!model) throw new Error('Offline fixture did not register its lead model.');
  await session.setModel(model);
  session.setThinkingLevel(LEAD.thinking);
  if (!session.getActiveToolNames().includes(TOOL)) {
    const state = sessionManager.getBranch().findLast(entry => entry.type === 'custom' && entry.customType === STATE)?.data;
    throw new Error(`Sidekick tool is inactive; state=${JSON.stringify(state)}; startup=${notifications.join(' | ') || 'no notification'}; providers=${modelRuntime.getRegisteredProviderIds().join(',')}`);
  }
  return { session, sessionManager };
}

async function prompt(session: any, message: string) {
  await session.prompt(message);
  return session.getLastAssistantText() ?? '';
}

async function runProbe() {
  const agentDir = process.env.PI_CODING_AGENT_DIR!;
  const cwdA = process.env.PI_SIDEKICK_ORCHESTRATION_CWD_A!;
  const cwdB = process.env.PI_SIDEKICK_ORCHESTRATION_CWD_B!;
  const cwdUntrusted = process.env.PI_SIDEKICK_ORCHESTRATION_CWD_UNTRUSTED!;
  const nativeLog = process.env.PI_SIDEKICK_NATIVE_TOOL_LOG!;
  const sessionA = await createLead(cwdA, true);
  let sessionB: Awaited<ReturnType<typeof createLead>> | undefined;
  let untrusted: Awaited<ReturnType<typeof createLead>> | undefined;
  try {
    sessionB = await createLead(cwdB, true);

    const waitA = waitForAction(sessionA.session, 'sleep 30');
    const waitB = waitForAction(sessionB.session, 'sleep 5');
    const taskA = sessionA.session.prompt('WAIT long child task').then(() => undefined, error => String(error));
    const taskB = sessionB.session.prompt('WAIT_SHORT child task').then(() => undefined, error => String(error));
    await Promise.all([waitA, waitB]);
    if (!sessionA.session.isStreaming || !sessionB.session.isStreaming) {
      throw new Error('Both independent Agent-like sessions should still be running before cancellation.');
    }
    await sessionA.session.abort();
    await Promise.all([taskA, taskB]);

    const checkpointA = checkpoint(sessionA.sessionManager);
    const checkpointB = checkpoint(sessionB.sessionManager);
    if (!checkpointA?.file || !checkpointB?.file) throw new Error('Both Agent sessions must save their Sidekick checkpoint.');
    const workerA = SessionManager.open(checkpointA.file, join(agentDir, 'sidekick', 'sessions'));
    const workerB = SessionManager.open(checkpointB.file, join(agentDir, 'sidekick', 'sessions'));
    await prompt(sessionB.session, 'WRITE in assigned workspace');

    await prompt(sessionB.session, 'NATIVE_AGENT trusted project');
    await prompt(sessionB.session, 'NATIVE_WORKFLOW trusted project');
    const readNativeCalls = () => existsSync(nativeLog)
      ? readFileSync(nativeLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
      : [];
    const trustedNativeCallsEnabled = readNativeCalls().filter(call => call.cwd === cwdB);

    untrusted = await createLead(cwdUntrusted, false);
    await prompt(untrusted.session, 'NATIVE_AGENT untrusted project');
    await prompt(untrusted.session, 'NATIVE_WORKFLOW untrusted project');
    const untrustedNativeCallsEnabled = readNativeCalls().filter(call => call.cwd === cwdUntrusted);

    const workerSessionDir = join(agentDir, 'sidekick', 'sessions');
    const workerSessionsBefore = readdirSync(workerSessionDir).filter(file => file.endsWith('.jsonl')).sort();
    await prompt(untrusted.session, 'WRITE UNTRUSTED_SIDEKICK in untrusted workspace');
    const sidekickEntry = untrusted.sessionManager.getBranch().findLast(entry =>
      entry.type === 'message' && entry.message.role === 'toolResult' && entry.message.toolName === TOOL,
    );
    const untrustedCheckpoint = checkpoint(untrusted.sessionManager) ?? null;
    const untrustedStats = untrusted.sessionManager.getBranch()
      .filter(entry => entry.type === 'custom' && entry.customType === STATS).map(entry => entry.data);
    const workerSessionsAfter = readdirSync(workerSessionDir).filter(file => file.endsWith('.jsonl')).sort();
    const workerCallsBeforeOff = existsSync(process.env.PI_SIDEKICK_TEST_LOG!)
      ? readFileSync(process.env.PI_SIDEKICK_TEST_LOG!, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
      : [];
    const untrustedWorkerCalls = workerCallsBeforeOff.filter(event => event.child && event.model
      && event.prompt.includes('UNTRUSTED_SIDEKICK'));

    await prompt(untrusted.session, '/sidekick off');
    await prompt(untrusted.session, 'NATIVE_AGENT after Sidekick off');
    await prompt(untrusted.session, 'NATIVE_WORKFLOW after Sidekick off');
    const untrustedNativeCallsOff = readNativeCalls().filter(call => call.cwd === cwdUntrusted)
      .slice(untrustedNativeCallsEnabled.length);

    await prompt(sessionB.session, '/sidekick off');
    await prompt(sessionB.session, 'NATIVE_AGENT trusted after Sidekick off');
    await prompt(sessionB.session, 'NATIVE_WORKFLOW trusted after Sidekick off');
    const nativeCalls = readNativeCalls();
    const trustedNativeCallsOff = nativeCalls.filter(call => call.cwd === cwdB)
      .slice(trustedNativeCallsEnabled.length);
    const recordsA = sessionA.sessionManager.getBranch()
      .filter(entry => entry.type === 'custom' && entry.customType === STATS).map(entry => entry.data);
    const recordsB = sessionB.sessionManager.getBranch()
      .filter(entry => entry.type === 'custom' && entry.customType === STATS).map(entry => entry.data);
    const workerCalls = existsSync(process.env.PI_SIDEKICK_TEST_LOG!)
      ? readFileSync(process.env.PI_SIDEKICK_TEST_LOG!, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
      : [];
    return {
      owners: { a: sessionA.sessionManager.getSessionId(), b: sessionB.sessionManager.getSessionId() },
      checkpoints: { a: checkpointA, b: checkpointB },
      workers: {
        a: { id: workerA.getSessionId(), cwd: workerA.getCwd() },
        b: { id: workerB.getSessionId(), cwd: workerB.getCwd() },
      },
      files: {
        outputA: existsSync(join(cwdA, 'output.txt')),
        outputB: existsSync(join(cwdB, 'output.txt')),
        outputUntrusted: existsSync(join(cwdUntrusted, 'output.txt')),
      },
      stats: { a: recordsA.map(record => record.outcome), b: recordsB.map(record => record.outcome) },
      nativeCalls,
      trustedNativeCallsEnabled,
      trustedNativeCallsOff,
      trustedNativeResults: nativeResults(sessionB.sessionManager),
      untrustedNativeCallsEnabled,
      untrustedNativeCallsOff,
      untrustedNativeResults: nativeResults(untrusted.sessionManager),
      untrustedSidekickResult: {
        isError: sidekickEntry?.message.isError === true,
        text: sidekickEntry?.message.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n') ?? '',
      },
      untrustedSidekickCheckpoint: untrustedCheckpoint,
      untrustedStats,
      untrustedWorkerSessions: { before: workerSessionsBefore, after: workerSessionsAfter },
      untrustedWorkerCalls,
      workerCalls: workerCalls.filter(event => event.child && event.model),
    };
  } finally {
    for (const item of [sessionA, sessionB, untrusted]) {
      if (!item) continue;
      try {
        if (!item.session.isIdle) await item.session.abort();
        await item.session.prompt('/sidekick off');
      } catch {
        // Best-effort shutdown after preserving the original probe failure.
      }
      item.session.dispose();
    }
  }
}

export default function orchestrationProbe(pi: any) {
  if (process.env[WORKER_ENV] === '1') return;
  for (const name of ['Agent', 'SubagentWorkflow']) {
    pi.registerTool({
      name,
      label: name,
      description: 'Offline test stand-in for a native child-launch tool.',
      parameters: Type.Object({}),
      async execute(_id: string, _params: unknown, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: any) {
        const call = { name, cwd: ctx.cwd };
        appendFileSync(process.env.PI_SIDEKICK_NATIVE_TOOL_LOG!, `${JSON.stringify(call)}\n`);
        return { content: [{ type: 'text', text: `executed:${name}` }], details: undefined };
      },
    });
  }
  pi.registerCommand('fixture-orchestration', {
    description: 'Run the offline native-session orchestration contract test.',
    handler: async () => {
      try {
        const report = await runProbe();
        writeFileSync(process.env.PI_SIDEKICK_ORCHESTRATION_RESULT!, JSON.stringify(report));
      } catch (error) {
        writeFileSync(process.env.PI_SIDEKICK_ORCHESTRATION_RESULT!, JSON.stringify({ error: String(error), stack: error instanceof Error ? error.stack : undefined }));
        throw error;
      }
    },
  });
}
