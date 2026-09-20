import type {
  ContextSourceType,
  Conversation,
  ConversationSource,
  Message,
  MessageRole,
  ProjectData,
} from "../domain/types.ts";
import {
  type ContextPackResult,
  type ConversationConnector,
  createContextPack,
  type ExplicitContextItem,
} from "../domain/ai.ts";
import { type JobHandle, JobManager } from "./jobs.ts";
import { asErrorObject, type ErrorObject } from "./errors.ts";
import { id, now } from "../domain/util.ts";

export interface ConnectorHealth {
  connected: boolean;
  message?: string;
}

/** Fault-isolated protocol for ChatGPT/DeepSeek/豆包/other adapters. */
export interface ConversationConnectorAdapter {
  health(): Promise<ConnectorHealth>;
  listConversations(): Promise<unknown[]>;
  fetchConversation(id: string): Promise<unknown>;
  capturePage?(): Promise<unknown>;
  sendSelection?(selection: unknown): Promise<void>;
}

export interface ImportedMessage {
  external_id?: string | null;
  role?: MessageRole;
  content: unknown;
  attachments?: unknown[];
  created_at?: string | null;
}

export interface ImportedConversation {
  external_id: string;
  title: string;
  messages: ImportedMessage[];
  external_created_at?: string | null;
  external_updated_at?: string | null;
  metadata?: Record<string, unknown>;
}

export type ConversationImportSource =
  | ImportedConversation[]
  | { conversations: ImportedConversation[] }
  | string
  | Uint8Array;

export interface ImportedConnectorOptions {
  provider?: string;
  display_name?: string;
  account_label?: string;
}

/**
 * Complete local/import adapter. It never reads a path or parses a payload in
 * the constructor; `sync()` is the explicit user-triggered boundary.
 */
export class ImportedConversationConnector
  implements ConversationConnectorAdapter, ConversationConnector {
  readonly provider: string;
  readonly display_name: string;
  readonly account_label: string;
  private loaded = false;
  private records = new Map<string, ImportedConversation>();

  constructor(
    private readonly source: ConversationImportSource,
    options: ImportedConnectorOptions = {},
  ) {
    this.provider = options.provider ?? "local-import";
    this.display_name = options.display_name ?? "本地对话导入";
    this.account_label = options.account_label ?? "本机导入";
  }

  private parse(value: unknown): ImportedConversation[] {
    const raw = Array.isArray(value)
      ? value
      : value && typeof value === "object" &&
          Array.isArray((value as { conversations?: unknown }).conversations)
      ? (value as { conversations: unknown[] }).conversations
      : [];
    return raw.flatMap((candidate): ImportedConversation[] => {
      if (!candidate || typeof candidate !== "object") return [];
      const item = candidate as Record<string, unknown>;
      const externalId = typeof item.external_id === "string"
        ? item.external_id
        : typeof item.id === "string"
        ? item.id
        : "";
      if (!externalId || typeof item.title !== "string") return [];
      const rawMessages = Array.isArray(item.messages) ? item.messages : [];
      const messages = rawMessages.flatMap((message): ImportedMessage[] => {
        if (!message || typeof message !== "object") return [];
        const value = message as Record<string, unknown>;
        const role = value.role === "assistant" || value.role === "system" ||
            value.role === "tool" || value.role === "user"
          ? value.role
          : "user";
        return [{
          external_id: typeof value.external_id === "string"
            ? value.external_id
            : typeof value.id === "string"
            ? value.id
            : null,
          role,
          content: value.content ?? "",
          attachments: Array.isArray(value.attachments)
            ? value.attachments
            : [],
          created_at: typeof value.created_at === "string"
            ? value.created_at
            : null,
        }];
      });
      return [{
        external_id: externalId,
        title: item.title,
        messages,
        external_created_at: typeof item.external_created_at === "string"
          ? item.external_created_at
          : null,
        external_updated_at: typeof item.external_updated_at === "string"
          ? item.external_updated_at
          : null,
        metadata: item.metadata && typeof item.metadata === "object"
          ? item.metadata as Record<string, unknown>
          : {},
      }];
    });
  }

  private async sourceValue(): Promise<unknown> {
    if (
      typeof this.source !== "string" && !(this.source instanceof Uint8Array)
    ) return this.source;
    const bytes = typeof this.source === "string"
      ? await Deno.readFile(this.source)
      : this.source;
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  }

  async sync(): Promise<void> {
    const records = this.parse(await this.sourceValue());
    this.records = new Map(
      records.map((record) => [record.external_id, structuredClone(record)]),
    );
    this.loaded = true;
  }

  async health(): Promise<ConnectorHealth> {
    await Promise.resolve();
    return this.loaded
      ? { connected: true, message: `${this.records.size} 条已导入对话` }
      : { connected: false, message: "等待用户主动导入对话" };
  }

  async check_login(): Promise<boolean> {
    return (await this.health()).connected;
  }

  async listConversations(): Promise<unknown[]> {
    await Promise.resolve();
    if (!this.loaded) return [];
    return [...this.records.values()].map((record) => ({
      external_id: record.external_id,
      title: record.title,
      external_created_at: record.external_created_at ?? null,
      external_updated_at: record.external_updated_at ?? null,
      metadata: record.metadata ?? {},
    }));
  }

  async list_conversations(): Promise<unknown[]> {
    return await this.listConversations();
  }

  async fetchConversation(externalId: string): Promise<unknown> {
    await Promise.resolve();
    if (!this.loaded) throw new Error("请先主动导入对话");
    const record = this.records.get(externalId);
    if (!record) throw new Error(`找不到导入对话: ${externalId}`);
    return structuredClone(record);
  }

  async get_conversation(externalId: string): Promise<unknown> {
    return await this.fetchConversation(externalId);
  }

  async get_metadata(): Promise<Record<string, unknown>> {
    await Promise.resolve();
    return {
      provider: this.provider,
      display_name: this.display_name,
      account_label: this.account_label,
      loaded: this.loaded,
      conversation_count: this.records.size,
    };
  }

  async capturePage(): Promise<unknown> {
    await Promise.resolve();
    throw new Error("本地导入连接器不支持网页抓取");
  }
}

export interface ImportedConversationSyncResult {
  source: ConversationSource;
  conversations: Conversation[];
  messages: Message[];
}

/** Import only the IDs explicitly chosen by the user into canonical data. */
export async function syncSelectedConversations(
  data: ProjectData,
  connector: ImportedConversationConnector,
  externalIds: readonly string[],
): Promise<ImportedConversationSyncResult> {
  const metadata = await connector.get_metadata();
  const source: ConversationSource = {
    id: id(),
    provider: String(metadata.provider ?? "local-import"),
    display_name: String(metadata.display_name ?? "本地对话导入"),
    connector_type: "import",
    account_label: String(metadata.account_label ?? "本机导入"),
    connection_status: "connected",
    auth_reference: "",
    last_sync_at: now(),
  };
  const conversations: Conversation[] = [];
  const messages: Message[] = [];
  const importedRecords: ImportedConversation[] = [];
  // Fetch and validate every requested record before mutating canonical data.
  // A missing/failed selection must not leave a half-imported conversation.
  for (const externalId of externalIds) {
    importedRecords.push(
      await connector.fetchConversation(externalId) as ImportedConversation,
    );
  }
  data.conversation_sources.push(source);
  for (const raw of importedRecords) {
    const conversation: Conversation = {
      id: id(),
      source_id: source.id,
      external_id: raw.external_id,
      title: raw.title,
      external_created_at: raw.external_created_at ?? null,
      external_updated_at: raw.external_updated_at ?? null,
      synced_at: now(),
      metadata: (raw.metadata ?? {}) as Conversation["metadata"],
    };
    conversations.push(conversation);
    data.conversations.push(conversation);
    for (const imported of raw.messages ?? []) {
      const message: Message = {
        id: id(),
        conversation_id: conversation.id,
        external_id: imported.external_id ?? null,
        role: imported.role ?? "user",
        content: imported.content as Message["content"],
        attachments: (imported.attachments ?? []) as Message["attachments"],
        created_at: imported.created_at ?? now(),
      };
      messages.push(message);
      data.messages.push(message);
    }
  }
  return { source, conversations, messages };
}

export interface ConnectorResult<T> {
  ok: boolean;
  value: T | null;
  error: ErrorObject | null;
}

const success = <T>(value: T): ConnectorResult<T> => ({
  ok: true,
  value,
  error: null,
});

/** Connector errors are returned as data; a provider outage cannot take down the editor. */
export class IsolatedConnector {
  constructor(
    readonly id: string,
    readonly adapter: ConversationConnectorAdapter,
  ) {}

  private async call<T>(
    operation: string,
    run: () => Promise<T>,
  ): Promise<ConnectorResult<T>> {
    try {
      return success(await run());
    } catch (caught) {
      return {
        ok: false,
        value: null,
        error: {
          ...asErrorObject(caught, "connector_failed"),
          details: { operation, connector_id: this.id },
        },
      };
    }
  }

  health(): Promise<ConnectorResult<ConnectorHealth>> {
    return this.call("health", () => this.adapter.health());
  }

  listConversations(): Promise<ConnectorResult<unknown[]>> {
    return this.call(
      "list_conversations",
      () => this.adapter.listConversations(),
    );
  }

  fetchConversation(id: string): Promise<ConnectorResult<unknown>> {
    return this.call(
      "fetch_conversation",
      () => this.adapter.fetchConversation(id),
    );
  }

  capturePage(): Promise<ConnectorResult<unknown>> {
    return this.adapter.capturePage
      ? this.call("capture_page", () => this.adapter.capturePage!())
      : Promise.resolve({
        ok: false,
        value: null,
        error: asErrorObject(
          new Error("capture_page unavailable"),
          "connector_capability_unavailable",
        ),
      });
  }

  sendSelection(selection: unknown): Promise<ConnectorResult<null>> {
    return this.adapter.sendSelection
      ? this.call("send_selection", async () => {
        await this.adapter.sendSelection!(selection);
        return null;
      })
      : Promise.resolve({
        ok: false,
        value: null,
        error: asErrorObject(
          new Error("send_selection unavailable"),
          "connector_capability_unavailable",
        ),
      });
  }
}

/** Registry-level isolation: one provider's parser/timeout cannot stop peers. */
export class ConnectorRegistry {
  private readonly connectors = new Map<string, IsolatedConnector>();

  register(
    id: string,
    adapter: ConversationConnectorAdapter,
  ): IsolatedConnector {
    const connector = new IsolatedConnector(id, adapter);
    this.connectors.set(id, connector);
    return connector;
  }

  remove(id: string): boolean {
    return this.connectors.delete(id);
  }

  get(id: string): IsolatedConnector | undefined {
    return this.connectors.get(id);
  }

  list(): string[] {
    return [...this.connectors.keys()];
  }

  async health(): Promise<Record<string, ConnectorResult<ConnectorHealth>>> {
    const entries = await Promise.all(
      [...this.connectors.entries()].map(async ([id, connector]) =>
        [id, await connector.health()] as const
      ),
    );
    return Object.fromEntries(entries);
  }
}

export interface SelectedContextSource {
  source_type: ContextSourceType;
  source_id: string;
  label: string;
  /** Resolution happens only for explicitly selected sources. */
  resolve(): Promise<string>;
}

export interface ContextPackPreview {
  selected: Array<
    {
      source_type: ContextSourceType;
      source_id: string;
      label: string;
      content_hash: string;
    }
  >;
  selected_content: string[];
}

/** Explicit context boundary: no source is resolved unless present in `selected`. */
export class ContextPackService {
  constructor(private readonly jobs = new JobManager()) {}

  async preview(
    selected: SelectedContextSource[],
  ): Promise<ContextPackPreview> {
    const resolved: ExplicitContextItem[] = [];
    for (const source of selected) {
      resolved.push({
        source_type: source.source_type,
        source_id: source.source_id,
        label: source.label,
        content: await source.resolve(),
      });
    }
    const { sha256 } = await import("../domain/util.ts");
    const selectedWithHashes = await Promise.all(
      resolved.map(async (source) => ({
        source_type: source.source_type,
        source_id: source.source_id,
        label: source.label,
        content_hash: await sha256(source.content),
      })),
    );
    return {
      selected: selectedWithHashes,
      selected_content: resolved.map((source) => source.content),
    };
  }

  build(
    data: ProjectData,
    input: {
      purpose: string;
      target_content_item_id?: string | null;
      model_connection_id?: string | null;
      selected: SelectedContextSource[];
    },
  ): JobHandle<ContextPackResult> {
    return this.jobs.start("准备 AI 上下文", async (job) => {
      job.update({
        message: "读取已选择的上下文",
        total: input.selected.length,
      });
      const items: ExplicitContextItem[] = [];
      for (const [index, source] of input.selected.entries()) {
        job.throwIfCancelled();
        items.push({
          source_type: source.source_type,
          source_id: source.source_id,
          label: source.label,
          content: await source.resolve(),
        });
        job.update({ current: index + 1 });
      }
      return await createContextPack(data, {
        purpose: input.purpose,
        target_content_item_id: input.target_content_item_id,
        model_connection_id: input.model_connection_id,
        items,
      });
    });
  }
}
