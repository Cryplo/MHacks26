/** C-10 evidence semantics, C-11 narration race + safe rendering. */
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AgentDetail, AppliedDecision, Narrative, ObservationFact, PlaceView, RuntimeClient } from '../../contract/behavior-v1';
import conformance from '../../fixtures/conformance-fixtures.json';
import { governance, knowledgeVsTruth, narrateFromState, optionRows, sourceLabel } from '../../src/features/inspector/evidence';
import { useNarration } from '../../src/features/inspector/useNarration';
import { NarrativeView } from '../../src/features/results/NarrativeView';
import { CommandRunner } from '../../src/runtime/commands';

const req = conformance.decisionRequest as unknown as AppliedDecision['request'];
// Raw differs from applied only within accepted round-off; sampled is NOT the highest.
const evidence: AppliedDecision = {
  evidenceId: 'ev1', request: req,
  response: { ...(conformance.decisionResult as unknown as AppliedDecision['response']), probabilities: [{ optionId: 'browse', probability: 0.2000004 }, { optionId: 'leave', probability: 0.1 }, { optionId: 'travel_splash', probability: 0.7 }] },
  appliedProbabilities: [{ optionId: 'browse', probability: 0.2 }, { optionId: 'leave', probability: 0.1 }, { optionId: 'travel_splash', probability: 0.7 }],
  draw: 0.25, chosenOptionId: 'leave', outcome: 'committed', failureReason: null, committedAtMs: 3600000, causedEventIds: ['e1'],
};

describe('evidence view-model (C-10)', () => {
  it('distinguishes the highest-probability option from the sampled one and keeps prompt order', () => {
    const rows = optionRows(evidence);
    expect(rows.map((r) => r.id)).toEqual(['travel_splash', 'browse', 'leave']);
    expect(rows.find((r) => r.highest)!.id).toBe('travel_splash');
    expect(rows.find((r) => r.sampled)!.id).toBe('leave');
    const leave = rows.find((r) => r.id === 'leave')!;
    expect(evidence.draw).toBeGreaterThanOrEqual(leave.cdfFrom);
    expect(evidence.draw).toBeLessThan(leave.cdfTo);
  });
  it('shows raw vs applied only where normalization changed a value', () => {
    const rows = optionRows(evidence);
    expect(rows.find((r) => r.id === 'browse')!.normalizationDiffers).toBe(true);
    expect(rows.find((r) => r.id === 'leave')!.normalizationDiffers).toBe(false);
  });
  it('labels mock/cache/fallback sources honestly', () => {
    expect(sourceLabel('mock', 'mock', 'm').text).toMatch(/not Jev/);
    expect(sourceLabel('cache', 'jev', 'm').text).toMatch(/Cached distribution.*nothing was copied/);
    expect(sourceLabel('fallback', 'fallback', 'm').text).toMatch(/not evidence of Jev/);
  });
  it('a child under a group decision did not have an independent sample', () => {
    const detail = { agent: { agentId: 'a002' }, evidence } as unknown as AgentDetail;
    expect(governance(detail).text).toMatch(/did not have an independently sampled action/);
    expect(governance({ agent: { agentId: 'a001' }, evidence } as unknown as AgentDetail).text).toMatch(/group leader/);
    expect(governance({ agent: { agentId: 'zzz' }, evidence } as unknown as AgentDetail).governed).toBe(false);
  });
  it('guest knowledge uses only observed facts and keeps the original wait promise', () => {
    const facts: ObservationFact[] = [{ ...(req.observation.facts[0] as ObservationFact) }];
    const truth = new Map<string, PlaceView>([['splash', { placeId: 'splash', closed: true, boardText: 'Splash Falls - 5 min', boardVersion: 'board:9', noticeVersion: 'n', predictedWaitMs: 300000 }]]);
    const rows = knowledgeVsTruth(facts, truth);
    expect(rows[0]!.guestFacts[0]!.text).toBe('Splash Falls - 35 minutes');
    expect(rows[0]!.guestFacts[0]!.waitUpperMs).toBe(2100000);
    expect(rows[0]!.truth!.closed).toBe(true);
  });
  it('local narration uses only recorded state', () => {
    expect(narrateFromState(evidence, 'a002')).toMatch(/selected "Head to the exit".*10\.0%/);
  });
});

function fakeRuntime(delays: Record<string, number>) {
  let n = 0;
  const works = new Map<string, { evidenceId: string; agentId: string; readyAt: number }>();
  const client = {
    command: vi.fn(async (_name: string, input: { request: { evidenceId: string; agentId: string } }, commandId: string) => {
      const workId = `w${++n}`;
      works.set(workId, { ...input.request, readyAt: Date.now() + (delays[input.request.evidenceId] ?? 0) });
      return { commandId, ok: true, result: { workId } };
    }),
    query: vi.fn(async (_name: string, input: { workId: string }) => {
      const w = works.get(input.workId)!;
      if (Date.now() < w.readyAt) return { workId: input.workId, kind: 'thought', status: 'leased', result: null, error: null };
      const narrative: Narrative = { id: `t-${w.evidenceId}`, evidenceHash: 'a'.repeat(64), origin: 'template', label: 'narrated from state', limitations: [],
        sections: [{ heading: 'h', segments: [{ kind: 'text', text: `about ${w.agentId}` }] }] };
      return { workId: input.workId, kind: 'thought', status: 'ready', result: narrative, error: null };
    }),
  } as unknown as RuntimeClient;
  return { client, runner: new CommandRunner(client, { sleep: async () => undefined }) };
}

describe('narration race (C-11)', () => {
  it('rapid A-to-B selection never attaches A narration to B', async () => {
    const { client, runner } = fakeRuntime({ evA: 250, evB: 0 });
    const { result, rerender } = renderHook(({ ev, agent }) => useNarration(client, runner, 'r1', ev, agent), { initialProps: { ev: 'evA', agent: 'A' } });
    await act(async () => { void result.current.request(); });
    rerender({ ev: 'evB', agent: 'B' });
    await act(async () => { await new Promise((r) => setTimeout(r, 450)); });
    expect(result.current.state.kind).toBe('idle'); // A's late result was discarded
    await act(async () => { await result.current.request(); });
    await waitFor(() => expect(result.current.state.kind).toBe('ready'));
    const st = result.current.state;
    if (st.kind !== 'ready') throw new Error('x');
    expect(st.narrative.id).toBe('t-evB');
    expect(st.key).toBe('r1|evB|B');
  });
});

describe('safe rendering (C-11)', () => {
  it('renders untrusted narrative text as text, never HTML', async () => {
    const n: Narrative = { id: 'n', evidenceHash: 'a'.repeat(64), origin: 'llm', label: 'narrated from state', limitations: ['<b>bold?</b>'],
      sections: [{ heading: '<img src=x onerror=alert(1)>', segments: [{ kind: 'text', text: '<script>window.__pwned=1</script><img src=x onerror="window.__pwned=2">' }] }] };
    const { container } = render(<NarrativeView narrative={n} facts={null} expectedEvidenceHash={null} />);
    await screen.findByText(/pwned=2/);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('b')?.textContent ?? '').not.toBe('bold?');
    expect(await screen.findByText(/<script>window.__pwned=1<\/script>/)).toBeInTheDocument();
    expect((window as { __pwned?: number }).__pwned).toBeUndefined();
  });
});
