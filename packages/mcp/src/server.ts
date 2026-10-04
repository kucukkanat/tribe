import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { descriptions, handlers, schemas, ToolError, type ToolContext, type ToolName } from "./tools.ts";
import { log } from "./log.ts";

export const SERVER_NAME = "tribe-mcp";
export const SERVER_VERSION = "0.1.0";

const readOnly = new Set<ToolName>(["memory_search", "memory_get", "memory_list_tags", "memory_recent"]);

export interface ServerOptions {
  ctx: ToolContext;
  /** Optional hook run before each tool call (e.g. lazy resync). */
  beforeCall?: () => Promise<void>;
}

export function buildServer({ ctx, beforeCall }: ServerOptions): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        `Tribe is this team's shared, end-to-end encrypted memory ("${ctx.bucket.name}"). ` +
        "Search it before answering questions about team systems, conventions or past decisions, and record durable, non-secret knowledge with memory_write. " +
        "Prefer updating an existing entry (pass entryId) over creating a duplicate.",
    },
  );

  for (const name of Object.keys(handlers) as ToolName[]) {
    const handler = handlers[name] as (c: ToolContext, a: any) => unknown;
    server.registerTool(
      name,
      {
        description: descriptions[name],
        inputSchema: schemas[name] as any,
        annotations: { readOnlyHint: readOnly.has(name), openWorldHint: false },
      },
      (async (args: unknown) => {
        try {
          if (beforeCall) await beforeCall();
          const out = await handler(ctx, args ?? {});
          return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }] };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!(err instanceof ToolError)) log(`tool ${name} failed:`, err);
          return { isError: true, content: [{ type: "text" as const, text: `Error: ${msg}` }] };
        }
      }) as any,
    );
  }
  return server;
}

export async function startServer(opts: ServerOptions, transport: Transport): Promise<McpServer> {
  const server = buildServer(opts);
  await server.connect(transport);
  return server;
}
