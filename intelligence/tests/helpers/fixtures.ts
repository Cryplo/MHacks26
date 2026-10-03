import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DecisionRequest, DecisionResult, MetricSnapshot, Scenario } from '../../contract/behavior-v1.ts';

export function readFixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url)), 'utf8')) as T;
}

export type Conformance = {
  disclaimer: string;
  decisionRequest: DecisionRequest;
  rawFixtureResponse: unknown;
  decisionResult: DecisionResult;
  metricSnapshot: MetricSnapshot;
  scenario: Scenario;
  rejectedReceipt: unknown;
};

export const conformance = (): Conformance => readFixture<Conformance>('conformance-fixtures.json');
export const golden = (): any => readFixture('golden-vectors.json');
