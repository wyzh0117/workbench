import type { ISODate, JsonValue, UUID } from "./types.ts";

export const now = (): ISODate => new Date().toISOString();
export const id = (): UUID => crypto.randomUUID();

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Stable enough for revisions and context hashes; keys are sorted recursively. */
export function stableJson(value: JsonValue | unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`);
  return `{${entries.join(",")}}`;
}

export function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  return sha256Bytes(bytes);
}

export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

export function maxOrder(values: Array<{ order_index: number }>): number {
  return values.reduce((max, value) => Math.max(max, value.order_index), -1);
}
