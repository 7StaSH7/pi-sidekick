import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultSidekickConfig, validateSidekickConfig } from './policy.mjs';

export const SIDEKICK_CONFIG_FILE = 'sidekick.json';
const LEGACY_CONFIG_FILE = 'fusion.json';

export function sidekickConfigPath(agentDir) {
  return join(agentDir, SIDEKICK_CONFIG_FILE);
}

function readConfig(file) {
  let value;
  try {
    value = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read ${file}: ${String(error)}`);
  }
  try {
    return validateSidekickConfig(value);
  } catch (error) {
    throw new Error(`${file}: ${String(error)}`);
  }
}

export function loadSidekickConfig(agentDir) {
  const file = sidekickConfigPath(agentDir);
  if (existsSync(file)) return readConfig(file);
  const legacyFile = join(agentDir, LEGACY_CONFIG_FILE);
  if (!existsSync(legacyFile)) return defaultSidekickConfig();
  return saveSidekickConfig(agentDir, readConfig(legacyFile));
}

export function saveSidekickConfig(agentDir, value) {
  const config = validateSidekickConfig(value);
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  const file = sidekickConfigPath(agentDir);
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
  return config;
}
