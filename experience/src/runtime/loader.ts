/**
 * Loads the RuntimeClient for the explicit profile. A missing or incompatible live adapter
 * is a startup error; there is NO fallback to fixture data.
 */
import { CONTRACT_VERSION, type Capabilities, type CreateRuntimeClient, type RuntimeClient } from '../../contract/behavior-v1';
import type { RuntimeSettings } from './config';
import type { TokenStore } from './tokenStore';
import { classifyError } from './errors';

export type StartupErrorKind = 'missing_adapter' | 'invalid_adapter' | 'version_mismatch' | 'connect_failed';
export class RuntimeStartupError extends Error {
  override name = 'RuntimeStartupError';
  constructor(readonly kind: StartupErrorKind, message: string, readonly detail: string | null = null) {
    super(message);
  }
}

export type LoadedRuntime = { client: RuntimeClient; capabilities: Capabilities; settings: RuntimeSettings };
export type LoaderDeps = {
  importModule: (url: string) => Promise<unknown>;
  loadFixture: () => Promise<CreateRuntimeClient>;
  tokens: TokenStore;
};

export async function loadRuntime(settings: RuntimeSettings, deps: LoaderDeps): Promise<LoadedRuntime> {
  let create: CreateRuntimeClient;
  if (settings.profile === 'fixture') {
    create = await deps.loadFixture();
  } else {
    let mod: unknown;
    try {
      mod = await deps.importModule(settings.adapterUrl);
    } catch (e) {
      throw new RuntimeStartupError('missing_adapter',
        `The live runtime adapter could not be loaded from ${settings.adapterUrl}. Build Engine's browser client and copy it into public/runtime/ (see docs/HANDOFF.md). The app will not substitute fixture data.`,
        e instanceof Error ? e.message : String(e));
    }
    const fn = (mod as { createRuntimeClient?: unknown } | null)?.createRuntimeClient;
    if (typeof fn !== 'function') {
      throw new RuntimeStartupError('invalid_adapter', `${settings.adapterUrl} does not export createRuntimeClient(config).`);
    }
    create = fn as CreateRuntimeClient;
  }

  let client: RuntimeClient;
  try {
    client = await create({
      uri: settings.uri, database: settings.database, token: deps.tokens.get(),
      onToken: (token) => deps.tokens.set(token),
    });
  } catch (e) {
    throw new RuntimeStartupError('connect_failed', 'The runtime adapter loaded but could not connect.', classifyError(e).error.message);
  }
  if (client.contractVersion !== CONTRACT_VERSION) {
    await client.close().catch(() => undefined);
    throw new RuntimeStartupError('version_mismatch',
      `Runtime adapter speaks ${String(client.contractVersion)}, but this build requires ${CONTRACT_VERSION}.`);
  }
  let capabilities: Capabilities;
  try {
    capabilities = await client.query('capabilities', {});
  } catch (e) {
    await client.close().catch(() => undefined);
    throw new RuntimeStartupError('connect_failed', 'Could not read server capabilities.', classifyError(e).error.message);
  }
  if (capabilities.contractVersion !== CONTRACT_VERSION) {
    await client.close().catch(() => undefined);
    throw new RuntimeStartupError('version_mismatch',
      `Server capabilities report ${String(capabilities.contractVersion)}, but this build requires ${CONTRACT_VERSION}.`);
  }
  return { client, capabilities, settings };
}
