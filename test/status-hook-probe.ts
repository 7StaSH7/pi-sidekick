import { appendFileSync } from 'node:fs';
import sidekick from '../index.ts';

function instrumentContext(ctx: any) {
  if (!ctx?.ui) return ctx;
  const ui = new Proxy(ctx.ui, {
    get(target, property) {
      if (property === 'setStatus') {
        return (name: string, text?: string) => {
          const path = process.env.PI_SIDEKICK_TEST_STATUS_LOG;
          if (path) appendFileSync(path, JSON.stringify({ name, text: text ?? null }) + '\n');
          return target.setStatus(name, text);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return new Proxy(ctx, {
    get(target, property) {
      if (property === 'ui') return ui;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function instrumentArgs(args: any[]) {
  const index = args.findLastIndex(value => value && typeof value === 'object' && value.ui);
  if (index < 0) return args;
  const result = [...args];
  result[index] = instrumentContext(result[index]);
  return result;
}

export default function statusHookProbe(pi: any) {
  const wrapped = new Proxy(pi, {
    get(target, property) {
      if (property === 'on') {
        return (event: string, handler: (...args: any[]) => unknown) => target.on(event, (...args: any[]) => handler(...instrumentArgs(args)));
      }
      if (property === 'registerCommand') {
        return (name: string, command: any) => target.registerCommand(name, {
          ...command,
          handler: (...args: any[]) => command.handler(...instrumentArgs(args)),
        });
      }
      if (property === 'registerTool') {
        return (tool: any) => target.registerTool({
          ...tool,
          execute: (...args: any[]) => tool.execute(...instrumentArgs(args)),
        });
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  sidekick(wrapped);
}
