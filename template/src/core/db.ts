// Single-table data access. DynamoDB in AWS, in-memory for tests/dev (DB_DRIVER=memory).
// Items are keyed by pk/sk. Use prefixes per entity, e.g. pk=`USER#<id>`, sk=`WORKOUT#<ts>`.
// CORE FILE — generated apps must not edit anything under src/core.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

export type Item = { pk: string; sk: string; [k: string]: unknown };

export interface QueryOpts {
  prefix?: string;
  limit?: number;
  newestFirst?: boolean;
}

export interface Db {
  get<T extends Item = Item>(pk: string, sk: string): Promise<T | undefined>;
  put(item: Item, opts?: { ifNotExists?: boolean }): Promise<void>;
  query<T extends Item = Item>(pk: string, opts?: QueryOpts): Promise<T[]>;
  /** Atomically increments numeric attributes, creating the item if needed. */
  increment(pk: string, sk: string, counters: Record<string, number>): Promise<void>;
  /** Shallow-merges attributes into an existing item (creates it if missing). */
  patch(pk: string, sk: string, attrs: Record<string, unknown>): Promise<void>;
  delete(pk: string, sk: string): Promise<void>;
}

export class ConflictError extends Error {}

class MemoryDb implements Db {
  private data = new Map<string, Item>();
  private key = (pk: string, sk: string) => `${pk}\u0000${sk}`;

  async get<T extends Item>(pk: string, sk: string) {
    const v = this.data.get(this.key(pk, sk));
    return v ? (structuredClone(v) as T) : undefined;
  }
  async put(item: Item, opts?: { ifNotExists?: boolean }) {
    const k = this.key(item.pk, item.sk);
    if (opts?.ifNotExists && this.data.has(k)) throw new ConflictError("exists");
    this.data.set(k, structuredClone(item));
  }
  async query<T extends Item>(pk: string, opts: QueryOpts = {}) {
    let rows = [...this.data.values()].filter(
      (i) => i.pk === pk && (!opts.prefix || i.sk.startsWith(opts.prefix)),
    );
    rows.sort((a, b) => (a.sk < b.sk ? -1 : a.sk > b.sk ? 1 : 0));
    if (opts.newestFirst) rows.reverse();
    if (opts.limit) rows = rows.slice(0, opts.limit);
    return structuredClone(rows) as T[];
  }
  async increment(pk: string, sk: string, counters: Record<string, number>) {
    const cur = (await this.get(pk, sk)) ?? { pk, sk };
    for (const [k, v] of Object.entries(counters)) cur[k] = ((cur[k] as number) ?? 0) + v;
    this.data.set(this.key(pk, sk), cur);
  }
  async patch(pk: string, sk: string, attrs: Record<string, unknown>) {
    const cur = (await this.get(pk, sk)) ?? { pk, sk };
    this.data.set(this.key(pk, sk), { ...cur, ...structuredClone(attrs), pk, sk });
  }
  async delete(pk: string, sk: string) {
    this.data.delete(this.key(pk, sk));
  }
  reset() {
    this.data.clear();
  }
}

class DynamoDb implements Db {
  private doc: DynamoDBDocumentClient;
  constructor(private table: string) {
    this.doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    });
  }
  async get<T extends Item>(pk: string, sk: string) {
    const r = await this.doc.send(new GetCommand({ TableName: this.table, Key: { pk, sk } }));
    return r.Item as T | undefined;
  }
  async put(item: Item, opts?: { ifNotExists?: boolean }) {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.table,
          Item: item,
          ConditionExpression: opts?.ifNotExists ? "attribute_not_exists(pk)" : undefined,
        }),
      );
    } catch (e: any) {
      if (e?.name === "ConditionalCheckFailedException") throw new ConflictError("exists");
      throw e;
    }
  }
  async query<T extends Item>(pk: string, opts: QueryOpts = {}) {
    const out: T[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const r = await this.doc.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: opts.prefix ? "pk = :pk AND begins_with(sk, :p)" : "pk = :pk",
          ExpressionAttributeValues: opts.prefix ? { ":pk": pk, ":p": opts.prefix } : { ":pk": pk },
          ScanIndexForward: !opts.newestFirst,
          Limit: opts.limit,
          ExclusiveStartKey: start,
        }),
      );
      out.push(...((r.Items ?? []) as T[]));
      start = r.LastEvaluatedKey;
    } while (start && (!opts.limit || out.length < opts.limit));
    return opts.limit ? out.slice(0, opts.limit) : out;
  }
  async increment(pk: string, sk: string, counters: Record<string, number>) {
    const names: Record<string, string> = {};
    const values: Record<string, number> = {};
    const parts = Object.entries(counters).map(([k, v], i) => {
      names[`#c${i}`] = k;
      values[`:c${i}`] = v;
      return `#c${i} :c${i}`;
    });
    await this.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { pk, sk },
        UpdateExpression: `ADD ${parts.join(", ")}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }),
    );
  }
  async patch(pk: string, sk: string, attrs: Record<string, unknown>) {
    const entries = Object.entries(attrs).filter(([k]) => k !== "pk" && k !== "sk");
    if (!entries.length) return;
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = {};
    const sets = entries.map(([k, v], i) => {
      names[`#a${i}`] = k;
      values[`:a${i}`] = v;
      return `#a${i} = :a${i}`;
    });
    await this.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { pk, sk },
        UpdateExpression: `SET ${sets.join(", ")}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }),
    );
  }
  async delete(pk: string, sk: string) {
    await this.doc.send(new DeleteCommand({ TableName: this.table, Key: { pk, sk } }));
  }
}

let instance: Db | undefined;
export const memoryDb = new MemoryDb();

export function db(): Db {
  if (!instance) {
    instance =
      process.env.DB_DRIVER === "memory" || !process.env.TABLE_NAME
        ? memoryDb
        : new DynamoDb(process.env.TABLE_NAME);
  }
  return instance;
}

export const now = () => new Date().toISOString();
export const id = () => crypto.randomUUID();
