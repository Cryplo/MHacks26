import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { Distribution, DomainError } from "../../contract/behavior-v1.js";

export class DomainFault extends Error {
  readonly error: DomainError;
  constructor(code: DomainError["code"], message: string, path = "") {
    super(message);
    this.name = "DomainFault";
    this.error = {
      code,
      message,
      retryable: false,
      fieldErrors: path ? [{ path, message }] : [],
    };
  }
}
export function ensure(
  condition: unknown,
  message: string,
  path = "",
): asserts condition {
  if (!condition) throw new DomainFault("INVALID_INPUT", message, path);
}
export function canonical(value: unknown): string {
  const seen = new Set<object>();
  function encode(v: unknown): string {
    if (v === null || typeof v === "boolean" || typeof v === "string")
      return JSON.stringify(v);
    if (typeof v === "number") {
      ensure(Number.isFinite(v), "Non-finite JSON number");
      return JSON.stringify(v);
    }
    ensure(typeof v === "object" && v !== null, "Unsupported JSON value");
    ensure(!seen.has(v), "Cyclic JSON value");
    seen.add(v);
    let output: string;
    if (Array.isArray(v)) {
      output = `[${Array.from(v, encode).join(",")}]`;
    } else {
      ensure(
        Object.getPrototypeOf(v) === Object.prototype ||
          Object.getPrototypeOf(v) === null,
        "Non-plain JSON object",
      );
      ensure(Object.getOwnPropertySymbols(v).length === 0, "Symbol JSON key");
      const object = v as Record<string, unknown>;
      output = `{${Object.keys(object)
        .sort()
        .filter((k) => object[k] !== undefined)
        .map((k) => `${JSON.stringify(k)}:${encode(object[k])}`)
        .join(",")}}`;
    }
    seen.delete(v);
    return output;
  }
  return encode(value);
}
export const hashBytes = (bytes: Uint8Array): string =>
  bytesToHex(sha256(bytes));
export const hash = (value: unknown): string =>
  hashBytes(new TextEncoder().encode(canonical(value)));
export function random(
  seed: string,
  stream: string,
  ...keys: (string | number)[]
): number {
  return (
    parseInt(
      hash(["behavior-rng-v1", seed, stream, ...keys]).slice(0, 13),
      16,
    ) /
    2 ** 52
  );
}
export function checkedInt(
  value: number,
  name = "integer",
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): number {
  ensure(
    Number.isSafeInteger(value) && value >= min && value <= max,
    `Invalid ${name}`,
  );
  return value;
}
export const cents = (value: number) => checkedInt(value, "cents");
export const total = (price: number, quantity: number) =>
  cents(cents(price) * checkedInt(quantity, "quantity", 1));
export const addCents = (a: number, b: number) => cents(cents(a) + cents(b));
export function debit(balance: number, amount: number): number {
  cents(balance);
  cents(amount);
  ensure(amount <= balance, "Insufficient wallet");
  return balance - amount;
}
export function boundary(value: number, name = "time"): number {
  checkedInt(value, name);
  ensure(value % 5000 === 0, `${name} must be a 5000 ms boundary`);
  return value;
}
export const clampMeter = (value: number): number =>
  Math.min(100, Math.max(0, value));
export const asciiCompare = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;
export function distribution(
  raw: Distribution,
  optionIds: string[],
): Distribution {
  ensure(
    raw.length === optionIds.length &&
      new Set(optionIds).size === optionIds.length,
    "Distribution cardinality mismatch",
  );
  const allowed = new Set(optionIds);
  let sum = 0;
  for (const entry of raw) {
    ensure(allowed.delete(entry.optionId), "Unknown or duplicate option");
    ensure(
      Number.isFinite(entry.probability) && entry.probability >= 0,
      "Invalid probability",
    );
    sum += entry.probability;
  }
  ensure(sum > 0 && Math.abs(sum - 1) <= 1e-6, "Distribution must sum to one");
  return raw
    .map((p) => ({ ...p, probability: p.probability / sum }))
    .sort((a, b) => asciiCompare(a.optionId, b.optionId));
}
export function sample(probabilities: Distribution, u: number): string {
  ensure(Number.isFinite(u) && u >= 0 && u < 1, "Draw outside [0,1)");
  const normalized = distribution(
    probabilities,
    probabilities.map((p) => p.optionId),
  );
  let sum = 0;
  for (const entry of normalized) {
    sum += entry.probability;
    if (u < sum) return entry.optionId;
  }
  return normalized[normalized.length - 1]!.optionId;
}
