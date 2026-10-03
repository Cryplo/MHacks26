import document from "./contract-schema.json";
import { DomainFault, canonical } from "./primitives.js";
type Schema = {
  $ref?: string;
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean | Schema;
  items?: Schema;
  anyOf?: Schema[];
  allOf?: Schema[];
  enum?: unknown[];
  const?: unknown;
};
const definitions = document.definitions as unknown as Record<string, Schema>;
export function validateContract(type: string, value: unknown): void {
  const schema = definitions[type];
  if (!schema) throw new Error(`Unknown contract schema ${type}`);
  validate(schema, value, "$", 0);
}
export function validatePortInput(
  port: "Commands" | "Queries",
  name: string,
  input: unknown,
) {
  const schema = definitions[port]?.properties?.[name]?.properties?.input;
  if (!schema) throw new DomainFault("INVALID_INPUT", `Unknown ${port} name`);
  validate(schema, input, "input", 0);
}
function fail(path: string, message: string): never {
  throw new DomainFault("INVALID_INPUT", message, path);
}
function validate(s: Schema, v: unknown, path: string, depth: number): void {
  if (depth > 100) fail(path, "JSON nesting limit");
  if (s.$ref) {
    const name = decodeURIComponent(s.$ref.replace("#/definitions/", "")),
      target = definitions[name];
    if (!target) throw new Error(`Unresolved schema ${name}`);
    if (
      name === "Id" &&
      (typeof v !== "string" || !/^[A-Za-z0-9_.:-]{1,160}$/.test(v))
    )
      fail(path, "Invalid ID");
    if (name === "Hash" && (typeof v !== "string" || !/^[0-9a-f]{64}$/.test(v)))
      fail(path, "Invalid hash");
    if (
      (name === "SimMs" || name === "Cents") &&
      (!Number.isSafeInteger(v) || (name === "SimMs" && (v as number) < 0))
    )
      fail(path, "Invalid checked unit");
    validate(target, v, path, depth + 1);
    return;
  }
  if (s.anyOf) {
    for (const branch of s.anyOf) {
      try {
        validate(branch, v, path, depth + 1);
        return;
      } catch (e) {
        if (!(e instanceof DomainFault)) throw e;
      }
    }
    fail(path, "Value does not match any allowed variant");
  }
  if (s.allOf)
    for (const branch of s.allOf) validate(branch, v, path, depth + 1);
  if ("const" in s && v !== s.const) fail(path, "Invalid constant");
  if (s.enum && !s.enum.includes(v)) fail(path, "Unknown enum");
  const types = Array.isArray(s.type) ? s.type : s.type ? [s.type] : [];
  if (types.length) {
    const actual = v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
    if (!types.includes(actual)) fail(path, `Expected ${types.join("|")}`);
  }
  if (typeof v === "number" && !Number.isFinite(v))
    fail(path, "Non-finite number");
  if (typeof v === "string" && v.length > 1_500_000)
    fail(path, "String length limit");
  if (Array.isArray(v)) {
    if (v.length > 1_000_000) fail(path, "Array length limit");
    if (s.items)
      v.forEach((x, i) => validate(s.items!, x, `${path}[${i}]`, depth + 1));
  } else if (v !== null && typeof v === "object") {
    if (
      Object.getPrototypeOf(v) !== Object.prototype &&
      Object.getPrototypeOf(v) !== null
    )
      fail(path, "Plain JSON object required");
    const object = v as Record<string, unknown>;
    for (const field of s.required ?? [])
      if (!Object.hasOwn(object, field))
        fail(`${path}.${field}`, "Required field missing");
    for (const [key, value] of Object.entries(object)) {
      const field = s.properties?.[key];
      if (field) validate(field, value, `${path}.${key}`, depth + 1);
      else if (s.additionalProperties === false)
        fail(`${path}.${key}`, "Unknown field");
      else if (typeof s.additionalProperties === "object")
        validate(s.additionalProperties, value, `${path}.${key}`, depth + 1);
    }
  }
}
export function assertJsonSize(value: unknown, bytes = 2_000_000) {
  if (new TextEncoder().encode(canonical(value)).length > bytes)
    throw new DomainFault("INVALID_INPUT", "Payload byte limit");
}
