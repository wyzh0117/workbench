import { basename, dirname, join } from "node:path";
import type { ProjectData } from "../domain/types.ts";

export type SearchRecordType =
  | "project"
  | "stage"
  | "content"
  | "block"
  | "asset"
  | "requirement"
  | "inbox";

export interface SearchRecord {
  id: string;
  type: SearchRecordType;
  label: string;
  code: string | null;
  content: string;
  parent_id: string | null;
  updated_at: string;
  metadata?: Record<string, string | boolean | null>;
}

export interface SearchResult extends SearchRecord {
  /** A short match preview; canonical bodies stay in project JSON. */
  snippet: string;
  score: number;
}

export interface SearchOptions {
  limit?: number;
  types?: readonly SearchRecordType[];
  filter?: SearchFilter;
}

export interface SearchFilter {
  stage_id?: string | null;
  content_item_id?: string;
  requirement_status?: "open" | "resolved" | "ignored";
  requirement_scope?: "content" | "layout";
  asset_type?: string;
  asset_source_type?: string;
  status?: string;
  include_archived?: boolean;
}

export interface SearchIndex {
  readonly backend: "memory" | "json-fallback" | "sqlite";
  rebuild(data: ProjectData): Promise<void> | void;
  search(
    query: string,
    options?: SearchOptions,
  ): Promise<SearchResult[]> | SearchResult[];
  clear(): Promise<void> | void;
}

interface PersistedIndex {
  schema_version: 1;
  generated_at: string;
  records: SearchRecord[];
  inverted: Record<string, string[]>;
}

const tokenPattern = /[\p{L}\p{N}\p{Script=Han}]+/gu;

function normalizeText(value: unknown): string {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase();
}

function tokenize(value: unknown): string[] {
  const normalized = normalizeText(value);
  const words = normalized.match(tokenPattern) ?? [];
  const result = new Set<string>();
  for (const word of words) {
    // Index short CJK sequences by character and bounded n-grams so Cmd-K
    // works for Chinese titles without requiring a third-party tokenizer.
    if (/\p{Script=Han}/u.test(word)) {
      const characters = Array.from(word);
      for (let start = 0; start < characters.length; start += 1) {
        for (
          let width = 1;
          width <= 8 && start + width <= characters.length;
          width += 1
        ) {
          result.add(characters.slice(start, start + width).join(""));
        }
      }
    } else {
      result.add(word);
    }
  }
  return [...result];
}

function stringifyContent(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? "");
  } catch {
    return "";
  }
}

function snippet(content: string, query: string): string {
  const clean = content.replace(/\s+/g, " ").trim();
  if (clean.length <= 180) return clean;
  const normalized = normalizeText(clean);
  const position =
    normalizeText(query).split(/\s+/).map((part) => normalized.indexOf(part))
      .find((index) => index >= 0) ?? 0;
  return `${position > 32 ? "…" : ""}${
    clean.slice(Math.max(0, position - 32), Math.max(0, position - 32) + 180)
  }${clean.length > position + 148 ? "…" : ""}`;
}

function record(
  id: string,
  type: SearchRecordType,
  label: string,
  content: string,
  parent_id: string | null,
  updated_at: string,
  code: string | null = null,
  metadata: Record<string, string | boolean | null> = {},
): SearchRecord {
  return {
    id,
    type,
    label,
    code,
    // Keep the full searchable text.  The index is a rebuildable cache, and
    // truncating here would make long-document matches silently disappear.
    content,
    parent_id,
    updated_at,
    metadata,
  };
}

export function recordsFromProject(data: ProjectData): SearchRecord[] {
  const records: SearchRecord[] = [
    record(
      data.project.id,
      "project",
      data.project.title,
      data.project.description,
      null,
      data.project.updated_at,
      null,
      { archived: data.project.archived },
    ),
  ];
  for (const stage of data.stages) {
    records.push(
      record(
        stage.id,
        "stage",
        stage.title,
        `${stage.code} ${stage.description} ${stage.learning_action}`,
        stage.parent_stage_id,
        stage.updated_at,
        stage.code,
        { stage_id: stage.id, archived: stage.archived },
      ),
    );
  }
  const documentById = new Map(
    data.documents.map((document) => [document.id, document.content_item_id]),
  );
  for (const item of data.content_items) {
    const statusMetadata = Object.fromEntries(
      data.status_assignments.filter((assignment) =>
        assignment.content_item_id === item.id
      ).flatMap((assignment) => {
        const dimension = data.status_dimensions.find((candidate) =>
          candidate.id === assignment.dimension_id
        );
        const option = data.status_options.find((candidate) =>
          candidate.id === assignment.option_id
        );
        return dimension && option
          ? [[`status_${dimension.key}`, option.key]]
          : [];
      }),
    ) as Record<string, string | boolean | null>;
    const contentStatus = statusMetadata.status_content ?? null;
    records.push(
      record(
        item.id,
        "content",
        item.title,
        `${item.code} ${item.description} ${item.type}`,
        item.stage_id,
        item.updated_at,
        item.code,
        {
          stage_id: item.stage_id,
          content_item_id: item.id,
          archived: item.archived,
          status: contentStatus,
          ...statusMetadata,
        },
      ),
    );
  }
  for (const block of data.blocks) {
    const contentId = documentById.get(block.document_id);
    records.push(
      record(
        block.id,
        "block",
        block.type,
        stringifyContent(block.content),
        contentId ?? block.document_id,
        block.updated_at,
        null,
        { content_item_id: contentId ?? block.document_id },
      ),
    );
  }
  for (const asset of data.assets) {
    records.push(
      record(
        asset.id,
        "asset",
        asset.title || asset.filename,
        `${asset.filename} ${asset.description}`,
        data.project.id,
        asset.created_at,
        null,
        {
          asset_type: asset.type,
          asset_source_type: asset.source_type,
          archived: asset.archived,
        },
      ),
    );
  }
  for (const requirement of data.requirements) {
    records.push(
      record(
        requirement.id,
        "requirement",
        `待补 ${requirement.type}`,
        requirement.note,
        requirement.content_item_id,
        requirement.created_at,
        null,
        {
          content_item_id: requirement.content_item_id,
          requirement_status: requirement.status,
          requirement_scope: requirement.scope,
        },
      ),
    );
  }
  for (const item of data.inbox_items) {
    records.push(
      record(
        item.id,
        "inbox",
        item.title,
        item.body,
        item.content_item_id,
        item.updated_at,
        null,
        { content_item_id: item.content_item_id, status: item.status },
      ),
    );
  }
  return sortRecords(records);
}

/** In-memory inverted index used by the browser fallback and tests. */
export class MemorySearchIndex implements SearchIndex {
  readonly backend: SearchIndex["backend"] = "memory";
  protected records = new Map<string, SearchRecord>();
  protected inverted = new Map<string, Set<string>>();

  rebuild(data: ProjectData): void {
    this.clear();
    for (const item of sortRecords(recordsFromProject(data))) {
      this.records.set(item.id, item);
      for (
        const token of tokenize(
          `${item.label} ${item.code ?? ""} ${item.content}`,
        )
      ) {
        const bucket = this.inverted.get(token) ?? new Set<string>();
        bucket.add(item.id);
        this.inverted.set(token, bucket);
      }
    }
  }

  search(query: string, options: SearchOptions = {}): SearchResult[] {
    const limit = Math.max(1, Math.min(200, options.limit ?? 50));
    const types = options.types ? new Set(options.types) : null;
    const filter = options.filter ?? {};
    const tokens = tokenize(query);
    if (tokens.length === 0) return [];
    let candidateIds: Set<string> | null = null;
    for (const token of tokens) {
      const exact = this.inverted.get(token) ?? new Set<string>();
      const prefix = [...this.inverted.entries()].filter(([key]) =>
        key.startsWith(token)
      ).flatMap(([, ids]) => [...ids]);
      const ids = new Set([...exact, ...prefix]);
      candidateIds = candidateIds === null
        ? ids
        : new Set([...candidateIds].filter((id: string) => ids.has(id)));
    }
    const results: SearchResult[] = [];
    for (const id of candidateIds ?? []) {
      const item = this.records.get(id);
      if (
        !item || (types && !types.has(item.type)) ||
        !matchesFilter(item, filter)
      ) continue;
      const haystack = normalizeText(
        `${item.label} ${item.code ?? ""} ${item.content}`,
      );
      const exactMatches = tokens.filter((token) =>
        haystack.includes(token)
      ).length;
      const score = exactMatches * 10 +
        (normalizeText(item.code ?? "") === normalizeText(query) ? 100 : 0);
      results.push({
        ...structuredClone(item),
        snippet: snippet(item.content || item.label, query),
        score,
      });
    }
    return results.sort((left, right) =>
      right.score - left.score ||
      right.updated_at.localeCompare(left.updated_at) ||
      left.label.localeCompare(right.label)
    ).slice(0, limit);
  }

  clear(): void {
    this.records.clear();
    this.inverted.clear();
  }

  protected exportIndex(): PersistedIndex {
    return {
      schema_version: 1,
      // The cache is reproducible; wall-clock timestamps would make a
      // rebuild differ even when canonical data is unchanged.
      generated_at: "canonical-rebuild",
      records: sortRecords([...this.records.values()]),
      inverted: Object.fromEntries(
        [...this.inverted.entries()].sort(([left], [right]) =>
          left.localeCompare(right)
        ).map(([token, ids]) => [token, [...ids].sort()]),
      ),
    };
  }

  protected importIndex(input: PersistedIndex): void {
    this.clear();
    for (const item of input.records ?? []) this.records.set(item.id, item);
    for (const [token, ids] of Object.entries(input.inverted ?? {})) {
      this.inverted.set(token, new Set(ids));
    }
  }
}

/**
 * Persistent fallback when a native SQLite runtime is unavailable. The file
 * is a rebuildable cache, never canonical project state.
 */
export class FileSearchIndex extends MemorySearchIndex {
  override readonly backend: SearchIndex["backend"] = "json-fallback";
  readonly path: string;

  constructor(directory: string) {
    super();
    this.path = join(directory, "index.json");
  }

  async load(): Promise<boolean> {
    try {
      const parsed = JSON.parse(
        await Deno.readTextFile(this.path),
      ) as PersistedIndex;
      if (parsed?.schema_version !== 1 || !Array.isArray(parsed.records)) {
        return false;
      }
      this.importIndex(parsed);
      return true;
    } catch (caught) {
      if (caught instanceof Deno.errors.NotFound) return false;
      return false;
    }
  }

  async save(): Promise<void> {
    await Deno.mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp-${crypto.randomUUID()}`;
    await Deno.writeTextFile(
      temporary,
      JSON.stringify(this.exportIndex()) + "\n",
    );
    await Deno.rename(temporary, this.path);
  }

  override async rebuild(data: ProjectData): Promise<void> {
    // Avoid dispatching to the asynchronous `clear()` override.  A pending
    // cache removal could otherwise race the replacement rename and delete
    // the freshly rebuilt index.
    this.records.clear();
    this.inverted.clear();
    for (const item of sortRecords(recordsFromProject(data))) {
      this.records.set(item.id, item);
      for (
        const token of tokenize(
          `${item.label} ${item.code ?? ""} ${item.content}`,
        )
      ) {
        const bucket = this.inverted.get(token) ?? new Set<string>();
        bucket.add(item.id);
        this.inverted.set(token, bucket);
      }
    }
    await this.save();
  }

  override async clear(): Promise<void> {
    super.clear();
    try {
      await Deno.remove(this.path);
    } catch (caught) {
      if (!(caught instanceof Deno.errors.NotFound)) throw caught;
    }
  }
}

/**
 * Capability marker for a native desktop SQLite adapter.  It deliberately
 * does not pretend that the JSON fallback is SQLite; callers should inject a
 * real implementation when the desktop runtime supplies one.
 */
export class SQLiteSearchIndex implements SearchIndex {
  readonly backend: SearchIndex["backend"] = "sqlite";

  private unavailable(): never {
    throw new Error("原生 SQLite 索引尚未配置；请使用可重建文件索引");
  }

  rebuild(_data: ProjectData): Promise<void> {
    return Promise.reject(
      new Error("原生 SQLite 索引尚未配置；请使用可重建文件索引"),
    );
  }

  search(_query: string, _options?: SearchOptions): SearchResult[] {
    return this.unavailable();
  }

  clear(): Promise<void> {
    return Promise.reject(
      new Error("原生 SQLite 索引尚未配置；请使用可重建文件索引"),
    );
  }
}

export class SearchService {
  constructor(readonly index: SearchIndex = new MemorySearchIndex()) {}

  async rebuild(data: ProjectData): Promise<void> {
    await this.index.rebuild(data);
  }

  async search(
    query: string,
    options?: SearchOptions,
  ): Promise<SearchResult[]> {
    return await this.index.search(query, options);
  }
}

function sortRecords(records: SearchRecord[]): SearchRecord[] {
  return [...records].sort((left, right) =>
    left.type.localeCompare(right.type) || left.id.localeCompare(right.id)
  );
}

function matchesFilter(
  recordValue: SearchRecord,
  filter: SearchFilter,
): boolean {
  const metadata = recordValue.metadata ?? {};
  if (filter.stage_id !== undefined && metadata.stage_id !== filter.stage_id) {
    return false;
  }
  if (
    filter.content_item_id !== undefined &&
    metadata.content_item_id !== filter.content_item_id
  ) return false;
  if (
    filter.requirement_status !== undefined &&
    metadata.requirement_status !== filter.requirement_status
  ) return false;
  if (
    filter.requirement_scope !== undefined &&
    metadata.requirement_scope !== filter.requirement_scope
  ) return false;
  if (
    filter.asset_type !== undefined && metadata.asset_type !== filter.asset_type
  ) return false;
  if (
    filter.asset_source_type !== undefined &&
    metadata.asset_source_type !== filter.asset_source_type
  ) return false;
  if (filter.status !== undefined && metadata.status !== filter.status) {
    return false;
  }
  if (filter.include_archived !== true && metadata.archived === true) {
    return false;
  }
  return true;
}

/** Rebuild is the only source of truth for the cache; no cache is canonical. */
export async function rebuildSearchIndex(
  data: ProjectData,
  index: SearchIndex = new MemorySearchIndex(),
): Promise<SearchIndex> {
  await index.rebuild(data);
  return index;
}

export function createSearchIndex(
  workspaceDirectory: string,
  preferSQLite = true,
): SearchIndex {
  // No SQLite dependency is required for the web/Deno runtime. Keep the
  // native slot explicit, but report the actual rebuildable fallback until a
  // desktop SQLite adapter is injected.
  void preferSQLite;
  return new FileSearchIndex(workspaceDirectory);
}

export function searchIndexFilename(workspaceDirectory: string): string {
  return basename(join(workspaceDirectory, "index.json"));
}
