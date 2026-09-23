import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultFusionConfig, validateFusionConfig } from './policy.mjs';

export const FUSION_CONFIG_FILE = 'fusion.json';

export function fusionConfigPath(agentDir) {
  return join(agentDir, FUSION_CONFIG_FILE);
}

export function loadFusionConfig(agentDir) {
  const file = fusionConfigPath(agentDir);
  if (!existsSync(file)) return defaultFusionConfig();
  let value;
  try {
    value = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read ${file}: ${String(error)}`);
  }
  try {
    return validateFusionConfig(value);
  } catch (error) {
    throw new Error(`${file}: ${String(error)}`);
  }
}

export function saveFusionConfig(agentDir, value) {
  const config = validateFusionConfig(value);
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  const file = fusionConfigPath(agentDir);
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
  return config;
}
