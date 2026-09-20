import { id, now } from "../domain/util.ts";
import type { JsonObject } from "../domain/types.ts";

export type EventSource =
  | "user"
  | "ai-applied"
  | "migration"
  | "import"
  | "system";

export type DomainEventType =
  | "ContentItemRenamed"
  | "BlockInserted"
  | "RequirementCreated"
  | "RequirementResolved"
  | "AssetImported"
  | "StatusChanged"
  | "LayoutChanged"
  | "SnapshotCreated"
  | "SuggestionAccepted"
  | "BlockMoved"
  | "GroupCreated"
  | "GroupMoved"
  | "GroupUngrouped"
  | "ProjectChanged";

export interface DomainEvent {
  id: string;
  type: DomainEventType;
  project_id: string | null;
  entity_type: string;
  entity_id: string | null;
  occurred_at: string;
  source: EventSource;
  /** Metadata only.  Do not put body text or credentials in an event. */
  metadata: JsonObject;
}

export interface DerivedUpdate {
  id: string;
  kind: string;
  project_id: string | null;
  source_event_id: string;
  updated_at: string;
  payload: JsonObject;
}

export type UINotificationLevel = "info" | "success" | "warning" | "error";

export interface UINotification {
  id: string;
  level: UINotificationLevel;
  message: string;
  action_label?: string;
  action_command?: string;
  source_event_id?: string;
  created_at: string;
}

type Listener<T> = (value: T) => void | Promise<void>;

/**
 * Three distinct channels keep projections and UI feedback from masquerading
 * as canonical domain writes.  `emitDomain` does not implicitly emit either
 * derived updates or notifications: consumers must explicitly publish them.
 */
export class EventBus {
  private readonly domain = new Set<Listener<DomainEvent>>();
  private readonly derived = new Set<Listener<DerivedUpdate>>();
  private readonly ui = new Set<Listener<UINotification>>();
  private readonly activeTypes = new Set<DomainEventType>();

  onDomain(listener: Listener<DomainEvent>): () => void {
    this.domain.add(listener);
    return () => this.domain.delete(listener);
  }

  onDerived(listener: Listener<DerivedUpdate>): () => void {
    this.derived.add(listener);
    return () => this.derived.delete(listener);
  }

  onUI(listener: Listener<UINotification>): () => void {
    this.ui.add(listener);
    return () => this.ui.delete(listener);
  }

  async emitDomain(event: DomainEvent): Promise<void> {
    // A consumer that accidentally emits the same event synchronously cannot
    // cause an infinite event loop.  It is still visible to the audit caller.
    if (this.activeTypes.has(event.type)) return;
    this.activeTypes.add(event.type);
    try {
      await Promise.all([...this.domain].map((listener) => listener(event)));
    } finally {
      this.activeTypes.delete(event.type);
    }
  }

  async emitDerived(update: DerivedUpdate): Promise<void> {
    await Promise.all([...this.derived].map((listener) => listener(update)));
  }

  async notify(notification: UINotification): Promise<void> {
    await Promise.all([...this.ui].map((listener) => listener(notification)));
  }

  static domainEvent(
    input: Omit<DomainEvent, "id" | "occurred_at">,
  ): DomainEvent {
    return { ...input, id: id(), occurred_at: now() };
  }

  static derivedUpdate(
    input: Omit<DerivedUpdate, "id" | "updated_at">,
  ): DerivedUpdate {
    return { ...input, id: id(), updated_at: now() };
  }

  static notification(
    input: Omit<UINotification, "id" | "created_at">,
  ): UINotification {
    return { ...input, id: id(), created_at: now() };
  }
}
