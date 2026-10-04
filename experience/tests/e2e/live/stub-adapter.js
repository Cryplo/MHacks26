// TEST-ONLY contract stub served at /runtime/browser.js to prove the live profile loads an
// adapter module by URL. It holds no simulation and no fixture data; one park is reported
// INVALID so the setup page must surface validation issues.
const ref = { artifactId: 'stub-park', kind: 'park', sha256: '0'.repeat(64), byteLength: 2, mediaType: 'application/json', contractVersion: 'behavior.v1' };
const caps = { contractVersion: 'behavior.v1', eventKinds: ['closure'], workKinds: ['population'], features: { routeChoice: false, bumpReactions: false, splitGroups: false, speechBubbles: false, discountMessages: false }, maxGuests: 400, maxArtifactBytes: 1, maxChunkBytes: 1 };
export async function createRuntimeClient(config) {
  if (!config.token) config.onToken?.('stub-token');
  const err = (code, message) => Object.assign(new Error(message), { name: 'RuntimeClientError', error: { code, message, retryable: false, fieldErrors: [] }, transport: false });
  return {
    contractVersion: 'behavior.v1',
    async command(name, _input, commandId) { return { commandId, ok: false, error: { code: 'UNSUPPORTED', message: `stub adapter: ${name} not implemented`, retryable: false, fieldErrors: [] } }; },
    async query(name) {
      if (name === 'capabilities') return caps;
      if (name === 'session') return { identity: 'stub:operator', roles: ['operator'], runIds: [] };
      if (name === 'listParks') return { items: [{ parkId: 'harbor-lights', revision: 'stub-invalid', label: 'Harbor Lights (stub)', artifact: ref, status: 'invalid', issues: ['queue zone q_coaster_tempest is unreachable from the main gate (stub)'] }], nextCursor: null };
      throw err('NOT_FOUND', `stub adapter: ${name}`);
    },
    subscribeLive(_runId, h) { h.status('closed'); return () => {}; },
    subscribeWorkAvailable() { return () => {}; },
    async putArtifact() { throw err('UNSUPPORTED', 'stub'); },
    async getArtifact() { throw err('NOT_FOUND', 'stub'); },
    async close() {},
  };
}
