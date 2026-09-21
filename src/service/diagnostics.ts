import { id, now } from "../domain/util.ts";
import type { ProjectData } from "../domain/types.ts";
import { asErrorObject, type ErrorObject, redactSecrets } from "./errors.ts";

export type DiagnosticLevel = "debug" | "info" | "warn" | "error" | "fatal";

export interface DiagnosticEntry {
  id: string;
  occurred_at: string;
  level: DiagnosticLevel;
  code: string;
  message: string;
  details: Record<string, unknown>;
}

export interface DiagnosticLoggerOptions {
  /** Maximum bytes in the active log before it is moved to .1, .2, ... */
  max_bytes?: number;
  /** Number of rotated files to retain, excluding the active file. */
  max_files?: number;
  /** Optional file name inside the supplied directory. */
  filename?: string;
}

export interface DiagnosticBundle {
  generated_at: string;
  files: Array<{ name: string; contents: string }>;
}

const DEFAULT_MAX_BYTES = 512 * 1024;
const DEFAULT_MAX_FILES = 3;

function safeString(value: unknown): string {
  if (value instanceof Error) return value.message;
  return String(value ?? "");
}

function jsonLine(entry: DiagnosticEntry): string {
  return JSON.stringify(entry) + "\n";
}

/**
 * Small dependency-free rotating logger. It intentionally stores metadata,
 * not document bodies, and redacts secret-like keys before writing.
 */
export class DiagnosticLogger {
  readonly directory: string;
  readonly options: Required<DiagnosticLoggerOptions>;

  constructor(directory: string, options: DiagnosticLoggerOptions = {}) {
    this.directory = directory;
    this.options = {
      max_bytes: Math.max(1024, options.max_bytes ?? DEFAULT_MAX_BYTES),
      max_files: Math.max(0, options.max_files ?? DEFAULT_MAX_FILES),
      filename: options.filename ?? "diagnostics.log",
    };
  }

  get path(): string {
    return `${this.directory}/${this.options.filename}`;
  }

  private rotatedPath(index: number): string {
    return `${this.path}.${index}`;
  }

  private async rotateIfNeeded(incomingBytes: number): Promise<void> {
    let size = 0;
    try {
      size = (await Deno.stat(this.path)).size;
    } catch (caught) {
      if (!(caught instanceof Deno.errors.NotFound)) throw caught;
    }
    if (size === 0 || size + incomingBytes <= this.options.max_bytes) return;
    for (let index = this.options.max_files; index >= 1; index -= 1) {
      const oldPath = index === 1 ? this.path : this.rotatedPath(index - 1);
      const newPath = this.rotatedPath(index);
      try {
        await Deno.remove(newPath);
      } catch (caught) {
        if (!(caught instanceof Deno.errors.NotFound)) throw caught;
      }
      try {
        await Deno.rename(oldPath, newPath);
      } catch (caught) {
        if (!(caught instanceof Deno.errors.NotFound)) throw caught;
      }
    }
  }

  async write(
    level: DiagnosticLevel,
    code: string,
    message: string,
    details: Record<string, unknown> = {},
  ): Promise<DiagnosticEntry> {
    const entry: DiagnosticEntry = {
      id: id(),
      occurred_at: now(),
      level,
      code,
      // Do not persist arbitrary exception strings as user-facing content.
      message: safeString(redactSecrets(message)),
      details: redactSecrets(details) as Record<string, unknown>,
    };
    const line = jsonLine(entry);
    await Deno.mkdir(this.directory, { recursive: true });
    await this.rotateIfNeeded(new TextEncoder().encode(line).byteLength);
    // Provider error text can land in this file, so it is created private
    // (0600) exactly like the AI store; best effort on platforms without POSIX
    // modes, where the call simply has nothing to enforce.
    await Deno.writeTextFile(this.path, line, {
      append: true,
      create: true,
      mode: 0o600,
    });
    try {
      await Deno.chmod(this.path, 0o600);
    } catch {
      // Windows and some network filesystems cannot express POSIX modes.
    }
    return structuredClone(entry);
  }

  debug(
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ): Promise<DiagnosticEntry> {
    return this.write("debug", code, message, details);
  }

  info(
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ): Promise<DiagnosticEntry> {
    return this.write("info", code, message, details);
  }

  warn(
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ): Promise<DiagnosticEntry> {
    return this.write("warn", code, message, details);
  }

  error(
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ): Promise<DiagnosticEntry> {
    return this.write("error", code, message, details);
  }

  async recordError(
    error: unknown,
    fallbackCode = "unexpected_error",
  ): Promise<DiagnosticEntry> {
    const safe = asErrorObject(error, fallbackCode);
    return await this.write(
      safe.severity === "fatal" ? "fatal" : "error",
      safe.code,
      safe.technical_message,
      {
        severity: safe.severity,
        recoverable: safe.recoverable,
        recommended_action: safe.recommended_action,
        ...safe.details,
      },
    );
  }

  fatal(
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ): Promise<DiagnosticEntry> {
    return this.write("fatal", code, message, details);
  }

  async read(): Promise<DiagnosticEntry[]> {
    const files = [
      this.path,
      ...Array.from(
        { length: this.options.max_files },
        (_, index) => this.rotatedPath(index + 1),
      ),
    ];
    const entries: DiagnosticEntry[] = [];
    for (const path of files) {
      let text = "";
      try {
        text = await Deno.readTextFile(path);
      } catch (caught) {
        if (caught instanceof Deno.errors.NotFound) continue;
        throw caught;
      }
      for (const line of text.split(/\r?\n/).filter(Boolean)) {
        try {
          const parsed = JSON.parse(line) as DiagnosticEntry;
          if (
            parsed && typeof parsed === "object" &&
            typeof parsed.code === "string"
          ) entries.push(parsed);
        } catch {
          // A partially written line must not prevent the diagnostics panel
          // from opening after a crash.
        }
      }
    }
    return entries.sort((left, right) =>
      left.occurred_at.localeCompare(right.occurred_at)
    );
  }

  async exportBundle(): Promise<DiagnosticBundle> {
    const entries = await this.read();
    return {
      generated_at: now(),
      files: [{
        name: "diagnostics.json",
        contents: JSON.stringify(redactSecrets(entries), null, 2) + "\n",
      }],
    };
  }
}

export interface RecoveryJournalWriter {
  writeRecoveryJournal(journal: {
    transaction_id: string;
    project_id: string;
    canonical_revision: string;
    saved_at: string;
    project: ProjectData;
  }): Promise<void>;
}

/** Persist the last known canonical state before a fatal shutdown path. */
export async function writeRecoveryJournalBeforeFatal(
  writer: RecoveryJournalWriter,
  project: ProjectData,
  reason: unknown,
): Promise<ErrorObject | null> {
  const safe = asErrorObject(reason, "fatal_error");
  await writer.writeRecoveryJournal({
    transaction_id: id(),
    project_id: project.project.id,
    canonical_revision: project.project.updated_at,
    saved_at: now(),
    project: structuredClone(project),
  });
  return safe;
}

/**
 * Recovery-aware fatal handling for the desktop shell. The callback is kept
 * injectable so tests can simulate process termination without killing Deno.
 */
export async function handleFatal(
  writer: RecoveryJournalWriter,
  logger: DiagnosticLogger,
  project: ProjectData,
  reason: unknown,
  exit: (() => void) | null = null,
): Promise<void> {
  const safe = asErrorObject(reason, "fatal_error");
  try {
    await writeRecoveryJournalBeforeFatal(writer, project, reason);
  } catch (caught) {
    // A full/read-only disk can prevent the journal itself.  Keep the fatal
    // diagnostic and shutdown path alive instead of masking the original
    // failure with a second unhandled exception.
    await logger.error(
      "fatal_recovery_journal_failed",
      safeString(caught),
      { original_code: safe.code },
    );
  }
  await logger.fatal(safe.code, safe.technical_message, {
    severity: "fatal",
    details: safe.details,
  });
  exit?.();
}
