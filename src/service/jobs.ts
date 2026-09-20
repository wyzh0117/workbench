import { id, now } from "../domain/util.ts";
import { asErrorObject, type ErrorObject } from "./errors.ts";

export type JobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface JobProgress {
  current: number;
  total: number | null;
  message: string;
}

export interface JobRecord<T = unknown> {
  id: string;
  label: string;
  status: JobStatus;
  progress: JobProgress;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  result?: T;
  error?: ErrorObject;
}

export interface JobContext {
  readonly signal: AbortSignal;
  update(progress: Partial<JobProgress>): void;
  throwIfCancelled(): void;
}

export interface JobHandle<T> {
  readonly id: string;
  readonly promise: Promise<JobRecord<T>>;
  cancel(): boolean;
}

type JobListener = (job: JobRecord) => void | Promise<void>;

/** Cooperative, observable jobs used by import/search/AI/connector work. */
export class JobManager {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly listeners = new Set<JobListener>();

  subscribe(listener: JobListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get<T = unknown>(jobId: string): JobRecord<T> | undefined {
    return this.jobs.get(jobId) as JobRecord<T> | undefined;
  }

  list(): JobRecord[] {
    return [...this.jobs.values()].map((job) => structuredClone(job));
  }

  start<T>(
    label: string,
    runner: (context: JobContext) => Promise<T>,
  ): JobHandle<T> {
    const jobId = id();
    const controller = new AbortController();
    const record: JobRecord<T> = {
      id: jobId,
      label,
      status: "queued",
      progress: { current: 0, total: null, message: "等待开始" },
      created_at: now(),
      started_at: null,
      finished_at: null,
    };
    this.jobs.set(jobId, record);
    this.controllers.set(jobId, controller);
    const publish = () => {
      const snapshot = structuredClone(record);
      for (const listener of this.listeners) {
        Promise.resolve(listener(snapshot)).catch(() => undefined);
      }
    };
    const update = (progress: Partial<JobProgress>) => {
      record.progress = { ...record.progress, ...progress };
      publish();
    };
    const promise = (async (): Promise<JobRecord<T>> => {
      // Yield once so callers can observe `queued` and cancel before work starts.
      await Promise.resolve();
      if (controller.signal.aborted) {
        record.status = "cancelled";
        record.finished_at = now();
        publish();
        this.controllers.delete(jobId);
        return structuredClone(record);
      }
      record.status = "running";
      record.started_at = now();
      record.progress = { ...record.progress, message: "正在处理" };
      publish();
      const context: JobContext = {
        signal: controller.signal,
        update,
        throwIfCancelled: () => {
          if (controller.signal.aborted) {
            throw new DOMException("Job cancelled", "AbortError");
          }
        },
      };
      try {
        record.result = await runner(context);
        if (controller.signal.aborted) record.status = "cancelled";
        else record.status = "completed";
      } catch (caught) {
        if (
          controller.signal.aborted ||
          (caught instanceof DOMException && caught.name === "AbortError")
        ) {
          record.status = "cancelled";
        } else {
          record.status = "failed";
          record.error = asErrorObject(caught, "job_failed");
        }
      } finally {
        record.finished_at = now();
        publish();
        this.controllers.delete(jobId);
      }
      return structuredClone(record);
    })();
    return {
      id: jobId,
      promise,
      cancel: () => {
        const current = this.jobs.get(jobId);
        if (
          !current ||
          ["completed", "failed", "cancelled"].includes(current.status)
        ) return false;
        controller.abort();
        if (current.status === "queued") {
          current.status = "cancelled";
          current.finished_at = now();
          publish();
        }
        return true;
      },
    };
  }
}
