import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CreateRuntimeClient, RuntimeClient, RuntimeConfig } from '../../contract/behavior-v1.ts';
import { CONTRACT_VERSION } from '../../contract/behavior-v1.ts';

export type RuntimeMode = 'fixture' | 'spacetime';

export type RuntimeLoadConfig =
  | { mode: 'fixture'; create: () => RuntimeClient | Promise<RuntimeClient> }
  | { mode: 'spacetime'; adapterModulePath: string; config: RuntimeConfig; cwd?: string };

export class RuntimeLoadError extends Error {
  override name = 'RuntimeLoadError';
}

/**
 * Loads Engine's Node adapter (`engine/client/dist/node.js`) in spacetime mode. Real mode never
 * falls back to fixtures: a missing or incompatible adapter is an explicit error.
 */
export async function loadRuntimeClient(cfg: RuntimeLoadConfig): Promise<RuntimeClient> {
  if (cfg.mode === 'fixture') return cfg.create();
  if (cfg.mode !== 'spacetime') throw new RuntimeLoadError(`unknown runtime mode ${(cfg as { mode: string }).mode}`);
  if (!cfg.adapterModulePath) throw new RuntimeLoadError('BEHAVIOR_RUNTIME_ADAPTER is required in spacetime mode');
  const path = isAbsolute(cfg.adapterModulePath) ? cfg.adapterModulePath : resolve(cfg.cwd ?? process.cwd(), cfg.adapterModulePath);
  if (!existsSync(path)) throw new RuntimeLoadError(`Engine adapter not found at ${path}; build engine/client first (no fixture fallback in spacetime mode)`);
  const mod = await import(pathToFileURL(path).href) as { createRuntimeClient?: CreateRuntimeClient };
  if (typeof mod.createRuntimeClient !== 'function') throw new RuntimeLoadError(`${path} does not export createRuntimeClient`);
  const client = await mod.createRuntimeClient(cfg.config);
  if (client.contractVersion !== CONTRACT_VERSION) {
    await client.close();
    throw new RuntimeLoadError(`adapter contract ${client.contractVersion} is not ${CONTRACT_VERSION}`);
  }
  return client;
}
