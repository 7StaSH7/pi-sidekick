export const MAX_ACTIVITY_ACTIONS = 5;
export const BRAILLE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
export const FRAME_INTERVAL_MS = 80;

// Display-only heartbeat; never starts model requests or writes session entries.
export function startActivityAnimation(onFrame, signal) {
  if (signal?.aborted) return () => {};
  let frame = 0;
  const timer = setInterval(() => onFrame(++frame), FRAME_INTERVAL_MS);
  timer.unref?.();
  const stop = () => {
    clearInterval(timer);
    signal?.removeEventListener('abort', stop);
  };
  signal?.addEventListener('abort', stop, { once: true });
  return stop;
}

const MAX_LABEL_LENGTH = 140;
const MAX_STAGE_LENGTH = 80;
const MAX_NAME_LENGTH = 90;
const MAX_COMMAND_LENGTH = 110;

export function clean(value, limit = MAX_LABEL_LENGTH) {
  let text = String(value ?? '')
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length > limit) text = `${text.slice(0, Math.max(1, limit - 1))}…`;
  return text;
}

function number(value) {
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? Math.floor(result) : undefined;
}

function firstNumber(...values) {
  return values.map(number).find(value => value !== undefined);
}

function pathOf(args) {
  return clean(args?.path ?? args?.file ?? args?.directory ?? '', 105);
}

function lineRange(args) {
  const start = firstNumber(args?.line_start, args?.start_line, args?.startLine, args?.line);
  const end = firstNumber(args?.line_end, args?.end_line, args?.endLine);
  if (start !== undefined && end !== undefined) return `:${start}–${end}`;
  if (start !== undefined) return `:${start}`;
  const offset = firstNumber(args?.offset);
  const limit = firstNumber(args?.limit);
  if (offset !== undefined && limit !== undefined && limit > 0) return `:${offset}–${offset + limit - 1}`;
  return '';
}

const SUSPICIOUS_COMMAND = /(?:\b(?:api[_-]?key|token|password|passwd|secret|authorization|bearer|private[_-]?key)\b\s*(?:=|:)\s*\S+|--(?:api[-_]?key|token|password|secret)\s+\S+|\b(?:sk-[a-z0-9]|gh[pousr]_[a-z0-9]+)|\.(?:env|pem|key)\b|\bcredentials?\b)/i;

function commandLabel(args) {
  const command = clean(args?.command ?? '', Number.MAX_SAFE_INTEGER);
  if (!command) return 'bash';
  return SUSPICIOUS_COMMAND.test(command) ? 'bash [command hidden: possible secret]' : `bash ${clean(command, MAX_COMMAND_LENGTH)}`;
}

export function describeTool(toolName, args = {}) {
  const name = clean(toolName, 40).toLowerCase();
  const path = pathOf(args);
  switch (name) {
    case 'read': return `read ${path || 'file'}${lineRange(args)}`;
    case 'grep': return `grep ${clean(args.pattern ?? args.query ?? args.search ?? 'text', 80)}${path ? ` in ${path}` : ''}`;
    case 'find': return `find ${clean(args.pattern ?? args.query ?? '*', 80)}${path ? ` in ${path}` : ''}`;
    case 'ls': return `ls ${path || 'directory'}`;
    case 'bash': return commandLabel(args);
    case 'edit': return `edit ${path || 'file'}`;
    case 'write': return `write ${path || 'file'}`;
    default: return `${clean(toolName, 40) || 'tool'}${path ? ` ${path}` : ''}`;
  }
}

function stage(state, text) {
  return `${state.name} · ${text}`;
}

export function createActivityState(name = 'sidekick') {
  const safeName = clean(name, MAX_NAME_LENGTH) || 'sidekick';
  return { name: safeName, stage: stage({ name: safeName }, 'starting'), completed: 0, actions: [], byId: new Map() };
}

export function resetActivity(state) {
  state.stage = stage(state, 'starting');
  state.completed = 0;
  state.actions.length = 0;
  state.byId.clear();
  return state;
}

function trimActions(state) {
  while (state.actions.length > MAX_ACTIVITY_ACTIONS) {
    const removed = state.actions.shift();
    if (removed.status !== 'running') state.byId.delete(removed.id);
  }
}

function running(state) {
  return [...state.byId.values()].some(action => action.status === 'running');
}

function phaseAfterTool(state) {
  state.stage = running(state) ? stage(state, 'executing actions') : stage(state, 'waiting for model');
}

function roleIsAssistant(event) {
  return event.message?.role === 'assistant';
}

function hasToolCall(event) {
  return (event.message?.content ?? []).some(part => part?.type === 'toolCall' || part?.type === 'tool_use');
}

export function applyActivityEvent(state, event, now = Date.now()) {
  switch (event?.type) {
    case 'agent_start':
      state.stage = stage(state, 'waiting for model');
      return true;
    case 'message_start':
    case 'message_update':
      if (!roleIsAssistant(event)) return false;
      state.stage = stage(state, 'receiving model response');
      return true;
    case 'message_end':
      if (!roleIsAssistant(event)) return false;
      state.stage = stage(state, hasToolCall(event) ? 'preparing actions' : 'model response received');
      return true;
    case 'agent_end':
      state.stage = stage(state, event.willRetry ? 'preparing continuation' : 'waiting to settle');
      return true;
    case 'agent_settled':
      state.stage = stage(state, 'ready');
      return true;
    case 'auto_retry_start':
      state.stage = stage(state, `retrying request ${number(event.attempt) ?? '?'}/${number(event.maxAttempts) ?? '?'}`);
      return true;
    case 'compaction_start':
      state.stage = stage(state, `compacting context (${clean(event.reason, 24) || 'in progress'})`);
      return true;
    case 'compaction_end':
      state.stage = stage(state, 'waiting for model');
      return true;
    case 'extension_error':
      state.stage = stage(state, 'extension error');
      return true;
    case 'tool_execution_start': {
      const id = String(event.toolCallId ?? '');
      if (!id) return false;
      const action = { id, label: describeTool(event.toolName, event.args), status: 'running', startedAt: now };
      state.byId.set(id, action);
      state.actions = state.actions.filter(item => item.id !== id);
      state.actions.push(action);
      trimActions(state);
      state.stage = stage(state, 'executing actions');
      return true;
    }
    case 'tool_execution_end': {
      const id = String(event.toolCallId ?? '');
      let action = state.byId.get(id);
      if (!action) {
        action = { id, label: describeTool(event.toolName), status: 'running', startedAt: now };
        state.byId.set(id, action);
        state.actions.push(action);
        trimActions(state);
      }
      if (action.status !== 'running') return false;
      action.status = event.isError ? 'error' : 'success';
      action.durationMs = Math.max(0, now - action.startedAt);
      state.completed += 1;
      if (!state.actions.includes(action)) state.byId.delete(id);
      phaseAfterTool(state);
      return true;
    }
    default:
      return false;
  }
}

function duration(value) {
  if (value < 1000) return `${value}ms`;
  if (value < 60000) return `${(value / 1000).toFixed(1).replace(/\.0$/, '')}s`;
  const minutes = Math.floor(value / 60000);
  return `${minutes}m ${Math.round((value % 60000) / 1000)}s`;
}

function row(action) {
  const icon = action.status === 'running' ? '▶' : action.status === 'error' ? '✗' : '✓';
  const suffix = action.status === 'running' ? ' · now' : action.durationMs === undefined ? '' : ` · ${duration(action.durationMs)}`;
  return clean(`${icon} ${action.label}${suffix}`, MAX_LABEL_LENGTH + 25);
}

export function formatActivity(state, frame) {
  const spinner = BRAILLE_FRAMES[(frame ?? 0) % BRAILLE_FRAMES.length];
  const detail = clean(`${state.stage} · completed: ${state.completed}`, MAX_NAME_LENGTH + MAX_STAGE_LENGTH + 35);
  return [`${spinner} Working`, detail, ...state.actions.map(row)].join('\n');
}
