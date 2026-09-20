import { id, now } from "../domain/util.ts";
import type { EventSource } from "./events.ts";

export interface AuditEntry {
  id: string;
  occurred_at: string;
  object_type: string;
  object_id: string | null;
  action: string;
  source: EventSource;
  metadata: Record<string, string | number | boolean | null>;
}

const SECRET_KEY =
  /(api[_-]?key|token|cookie|password|passphrase|secret|private[_-]?key|authorization|credential|body|content|raw_text)/i;
const SECRET_VALUE =
  /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|bearer[_-]?token|cookie|password|passphrase|secret|authorization)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi;

function safeString(value: string): string {
  return value.replace(SECRET_VALUE, "$1[REDACTED]");
}

function safeMetadata(value: Record<string, unknown>): AuditEntry["metadata"] {
  const result: AuditEntry["metadata"] = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) continue;
    if (
      item === null || typeof item === "number" || typeof item === "boolean"
    ) {
      result[key] = item;
    } else if (typeof item === "string") {
      result[key] = safeString(item);
    }
  }
  return result;
}

/** In-memory by default; callers can persist entries in .workspace if desired. */
export class AuditLog {
  private readonly entries: AuditEntry[] = [];

  record(
    input: Omit<AuditEntry, "id" | "occurred_at" | "metadata"> & {
      metadata?: Record<string, unknown>;
    },
  ): AuditEntry {
    const entry: AuditEntry = {
      ...input,
      id: id(),
      occurred_at: now(),
      metadata: safeMetadata(input.metadata ?? {}),
    };
    this.entries.push(entry);
    return structuredClone(entry);
  }

  list(): AuditEntry[] {
    return this.entries.map((entry) => structuredClone(entry));
  }

  clear(): void {
    this.entries.length = 0;
  }
}

export function auditMetadata(
  value: Record<string, unknown>,
): AuditEntry["metadata"] {
  return safeMetadata(value);
}
