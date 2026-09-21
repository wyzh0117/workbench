import type { ProjectData } from "../domain/types.ts";
import { id } from "../domain/util.ts";
import { touchProject } from "../domain/store.ts";
import {
  createBlockGroup,
  moveBlock,
  moveGroup,
  ungroupBlocks,
} from "../domain/document.ts";
import { AuditLog } from "./audit.ts";
import { type DomainEvent, EventBus, type EventSource } from "./events.ts";
import {
  asErrorObject,
  error,
  type ErrorObject,
  ServiceError,
} from "./errors.ts";

/** Only these high-level operations may cross the desktop bridge. */
export const HIGH_LEVEL_COMMANDS = [
  "project.open",
  "project.create",
  "project.save",
  "project.external.inspect",
  "project.reload",
  "project.merge",
  "project.resolve",
  "course.seed.create",
  "blueprint.build",
  "blueprint.confirm",
  "blueprint.discard",
  "import.preview",
  "import.confirm",
  "asset.import",
  "inbox.create",
  "inbox.triage",
  "inbox.assetize",
  "status.assign",
  "document.reorder",
  "block.move",
  "group.create",
  "group.move",
  "group.ungroup",
  "requirement.resolve",
  "layout.create",
  "layout.section.create",
  "placement.create",
  "snapshot.create",
  "snapshot.restore",
  "export.run",
  "publication.record",
  "secret.set",
  "secret.delete",
  "connector.sync",
  "ai.analyze",
  "suggestion.apply",
] as const;

export const READ_QUERIES = [
  "project.get",
  "course.tree",
  "requirements.missing",
  "assets.search",
  "snapshots.list",
  "jobs.list",
  "connector.health",
  "export.preflight",
  "search.query",
  "diagnostics.export",
] as const;

export type HighLevelCommand = typeof HIGH_LEVEL_COMMANDS[number];
export type ReadQuery = typeof READ_QUERIES[number];

export interface CommandContext {
  project: ProjectData | null;
  eventBus: EventBus;
  audit: AuditLog;
  source: EventSource;
  actor_id?: string | null;
}

export interface CommandResult<T = unknown> {
  value: T;
  events?: DomainEvent[];
  notification?: {
    level: "info" | "success" | "warning" | "error";
    message: string;
  };
  audit?: {
    object_type: string;
    object_id?: string | null;
    action: string;
    metadata?: Record<string, unknown>;
  };
  undo?: () => Promise<void> | void;
}

export type CommandHandler = (
  input: unknown,
  context: CommandContext,
) => Promise<CommandResult> | CommandResult;
export type QueryHandler = (
  input: unknown,
  context: Omit<CommandContext, "source">,
) => Promise<unknown> | unknown;
export type CommandErrorObserver = (
  error: ErrorObject,
  command: string,
) => Promise<void> | void;

export interface CommandDefinition {
  validate?: (input: unknown, context: CommandContext) => void | Promise<void>;
  execute: CommandHandler;
}

export interface CommandExecution<T> {
  id: string;
  value: T;
  error: ErrorObject | null;
  undo(): Promise<boolean>;
}

function ensureAllowed(name: string, allowed: readonly string[]): void {
  if (!allowed.includes(name)) {
    throw error(
      "command_not_allowed",
      "该操作不受支持。",
      `命令未列入白名单: ${name}`,
      {
        recoverable: false,
        recommended_action: "请从工作台提供的操作入口重试。",
        details: {},
      },
    );
  }
}

/** Explicit registration prevents exposing fs/shell/git primitives by accident. */
export class CommandBus {
  private readonly handlers = new Map<string, CommandHandler>();
  private readonly validators = new Map<
    string,
    NonNullable<CommandDefinition["validate"]>
  >();
  private readonly allowed: readonly string[];

  constructor(
    readonly context: CommandContext,
    allowed: readonly string[] = HIGH_LEVEL_COMMANDS,
    readonly onError: CommandErrorObserver | null = null,
  ) {
    // A caller may restrict the public surface, but can never widen it to a
    // raw fs/shell/git primitive at runtime.
    this.allowed = allowed.filter((name) =>
      HIGH_LEVEL_COMMANDS.includes(name as HighLevelCommand)
    );
  }

  register(
    name: HighLevelCommand,
    handler: CommandHandler | CommandDefinition,
  ): void {
    ensureAllowed(name, this.allowed);
    if (typeof handler === "function") {
      this.handlers.set(name, handler);
      return;
    }
    this.handlers.set(name, handler.execute);
    if (handler.validate) this.validators.set(name, handler.validate);
  }

  registerDefinition(
    name: HighLevelCommand,
    definition: CommandDefinition,
  ): void {
    this.register(name, definition);
  }

  has(name: string): boolean {
    return this.handlers.has(name);
  }

  async execute<T = unknown>(
    name: string,
    input: unknown = {},
  ): Promise<CommandExecution<T>> {
    const executionId = id();
    try {
      ensureAllowed(name, this.allowed);
      const handler = this.handlers.get(name);
      if (!handler) {
        throw error(
          "command_unavailable",
          "该操作暂时不可用。",
          `尚未注册命令: ${name}`,
          {
            recoverable: true,
            recommended_action: "检查桌面服务是否已启动。",
            details: {},
          },
        );
      }
      const validate = this.validators.get(name);
      if (validate) await validate(input, this.context);
      const result = await handler(input, this.context);
      if (result.events) {
        for (const domainEvent of result.events) {
          await this.context.eventBus.emitDomain(domainEvent);
        }
      }
      if (result.notification) {
        await this.context.eventBus.notify(
          EventBus.notification({ ...result.notification }),
        );
      }
      if (result.audit) {
        this.context.audit.record({
          object_type: result.audit.object_type,
          object_id: result.audit.object_id ?? null,
          action: result.audit.action,
          source: this.context.source,
          metadata: result.audit.metadata,
        });
      }
      return {
        id: executionId,
        value: result.value as T,
        error: null,
        undo: async () => {
          if (!result.undo) return false;
          await result.undo();
          return true;
        },
      };
    } catch (caught) {
      const safe = asErrorObject(caught, "command_failed");
      try {
        await this.onError?.(safe, name);
      } catch {
        // Diagnostics must never replace the command's structured failure.
      }
      return {
        id: executionId,
        value: undefined as T,
        error: safe,
        undo: () => Promise.resolve(false),
      };
    }
  }
}

export class QueryBus {
  private readonly handlers = new Map<string, QueryHandler>();

  constructor(readonly context: Omit<CommandContext, "source">) {}

  register(name: ReadQuery, handler: QueryHandler): void {
    ensureAllowed(name, READ_QUERIES);
    this.handlers.set(name, handler);
  }

  async execute<T = unknown>(name: string, input: unknown = {}): Promise<T> {
    ensureAllowed(name, READ_QUERIES);
    const handler = this.handlers.get(name);
    if (!handler) {
      throw error(
        "query_unavailable",
        "该查询暂时不可用。",
        `尚未注册查询: ${name}`,
      );
    }
    return await handler(input, this.context) as T;
  }
}

export function eventForCommand(
  input: Omit<DomainEvent, "id" | "occurred_at">,
): DomainEvent {
  return EventBus.domainEvent(input);
}

/** Reject common raw bridge primitives even if a caller tries to cast them. */
export function assertNoRawBridgeOperation(name: string): void {
  if (/^(fs\.|shell\.|git\.)/.test(name)) {
    throw new ServiceError({
      code: "raw_bridge_forbidden",
      user_message: "该底层操作不可直接调用。",
      technical_message: `禁止原始桌面操作: ${name}`,
      recoverable: false,
      recommended_action: "使用工作台提供的高层操作。",
      details: {},
    });
  }
}

/** High-level document commands used by the desktop bridge and tests. */
export function moveBlockCommand(
  input: {
    content_item_id: string;
    block_id: string;
    to_index: number;
    group_id?: string | null;
  },
  context: CommandContext,
): CommandResult {
  if (!context.project) throw new Error("项目尚未打开");
  const change = moveBlock(context.project, input);
  return {
    value: change.value,
    events: [eventForCommand({
      type: "BlockMoved",
      project_id: context.project.project.id,
      entity_type: "block",
      entity_id: input.block_id,
      source: context.source,
      metadata: { content_item_id: input.content_item_id },
    })],
    undo: change.undo,
    audit: {
      object_type: "block",
      object_id: input.block_id,
      action: "move",
      metadata: {
        content_item_id: input.content_item_id,
        group_id: input.group_id ?? null,
      },
    },
  };
}

export function createGroupCommand(
  input: {
    content_item_id: string;
    block_ids?: string[];
    title?: string;
    parent_group_id?: string | null;
  },
  context: CommandContext,
): CommandResult {
  if (!context.project) throw new Error("项目尚未打开");
  const group = createBlockGroup(
    context.project,
    input.content_item_id,
    input.block_ids ?? [],
    input.title ?? "未命名分组",
    input.parent_group_id ?? null,
  );
  return {
    value: group,
    events: [eventForCommand({
      type: "GroupCreated",
      project_id: context.project.project.id,
      entity_type: "group",
      entity_id: group.id,
      source: context.source,
      metadata: { content_item_id: input.content_item_id },
    })],
    undo: () => {
      const index = context.project!.groups.findIndex((candidate) =>
        candidate.id === group.id
      );
      if (index >= 0) context.project!.groups.splice(index, 1);
      touchProject(context.project!);
    },
    audit: { object_type: "group", object_id: group.id, action: "create" },
  };
}

export function moveGroupCommand(
  input: { group_id: string; to_index: number },
  context: CommandContext,
): CommandResult {
  if (!context.project) throw new Error("项目尚未打开");
  const change = moveGroup(context.project, input.group_id, input.to_index);
  return {
    value: change.value,
    events: [eventForCommand({
      type: "GroupMoved",
      project_id: context.project.project.id,
      entity_type: "group",
      entity_id: input.group_id,
      source: context.source,
      metadata: {},
    })],
    undo: change.undo,
    audit: { object_type: "group", object_id: input.group_id, action: "move" },
  };
}

export function ungroupCommand(
  input: { group_id: string },
  context: CommandContext,
): CommandResult {
  if (!context.project) throw new Error("项目尚未打开");
  const originalIndex = context.project.groups.findIndex((candidate) =>
    candidate.id === input.group_id
  );
  const group = ungroupBlocks(context.project, input.group_id);
  return {
    value: group,
    events: [eventForCommand({
      type: "GroupUngrouped",
      project_id: context.project.project.id,
      entity_type: "group",
      entity_id: input.group_id,
      source: context.source,
      metadata: {},
    })],
    undo: () => {
      context.project!.groups.splice(Math.max(0, originalIndex), 0, group);
      touchProject(context.project!);
    },
    audit: {
      object_type: "group",
      object_id: input.group_id,
      action: "ungroup",
    },
  };
}

/** Opt-in registration keeps the desktop bridge explicit and testable. */
export function registerDocumentCommands(bus: CommandBus): void {
  bus.register("block.move", (input, context) =>
    moveBlockCommand(
      input as {
        content_item_id: string;
        block_id: string;
        to_index: number;
        group_id?: string | null;
      },
      context,
    ));
  bus.register("group.create", (input, context) =>
    createGroupCommand(
      input as {
        content_item_id: string;
        block_ids?: string[];
        title?: string;
        parent_group_id?: string | null;
      },
      context,
    ));
  bus.register(
    "group.move",
    (input, context) =>
      moveGroupCommand(
        input as { group_id: string; to_index: number },
        context,
      ),
  );
  bus.register(
    "group.ungroup",
    (input, context) => ungroupCommand(input as { group_id: string }, context),
  );
}
