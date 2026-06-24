import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { MuninClient } from "@kalera/munin-sdk";
import { loadCliEnv, resolveProjectId, resolveEncryptionKey, safeError } from "./index.js";

function hasSingleIdentifier(args: Record<string, unknown>): args is Record<string, unknown> & { key?: string; id?: string } {
  const hasKey = typeof args.key === "string" && args.key.length > 0;
  const hasId = typeof args.id === "string" && args.id.length > 0;
  return hasKey !== hasId;
}

export function createMcpServerInstance(
  env: ReturnType<typeof loadCliEnv>,
  opts?: { allowMissingApiKey?: boolean },
) {
  if (!env.apiKey && !opts?.allowMissingApiKey) {
    throw new Error(
      "MUNIN_API_KEY is required. Set it in your environment, or in a .env.local / .env file in your project directory (walked up automatically).",
    );
  }

  const client = new MuninClient({
    baseUrl: env.baseUrl,
    apiKey: env.apiKey,
    timeoutMs: env.timeoutMs,
  });

  const server = new Server(
    {
      name: "munin-mcp-server",
      version: "1.4.1",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "munin_store_memory",
          description: "Store or update one or more memories in Munin Context Core. Auto-uses active project if projectId omitted. BATCH MODE: pass `memories: [...]` (up to 50 items per call) to save many memories in a single call — drastically reduces API quota usage at session end / /compact. When `memories` is provided, single-memory params (key/content/...) are ignored. TIPS for better recall later: (1) Set `validFrom`/`validTo` for time-bound facts so search auto-filters stale memories; (2) Pin durable identity facts via `isPinned: true`. IMPORTANT: Call as MCP tool, not shell command.",
          inputSchema: {
            type: "object",
            properties: {
              projectId: { type: "string", description: "Optional. Only use if cross-saving to a different Context Core ID." },
              key: { type: "string", description: "Unique identifier for this memory (single-memory mode)" },
              content: { type: "string", description: "The content to remember (single-memory mode)" },
              title: { type: "string", description: "Optional title" },
              tags: {
                type: "array",
                items: { type: "string" },
                description: "List of tags, e.g. ['planning', 'frontend']"
              },
              validFrom: {
                type: "string",
                description: "Optional ISO-8601 date — memory is hidden from search before this date. Use for facts that take effect later (e.g., new policy). Omit for always-valid memories."
              },
              validTo: {
                type: "string",
                description: "Optional ISO-8601 date — memory expires from search after this date. Use for time-bound facts (deadlines, sprint goals, expiring promotions). Omit for never-expiring."
              },
              isPinned: {
                type: "boolean",
                description: "Mark as pinned to boost in search ranking. Reserve for high-importance identity/anchor facts (project name, user role, key constraints)."
              },
              memories: {
                type: "array",
                description: "OPTIONAL. For batch storing up to 50 memories in one call (saves API quota at /compact / session end). Each item has same shape as single-memory params (key, content, tags, title, validFrom, validTo, isPinned). When provided, single-memory params (key/content/...) are ignored. Returns per-item success/error in `data.results`.",
                maxItems: 50,
                items: {
                  type: "object",
                  properties: {
                    key: { type: "string" },
                    content: { type: "string" },
                    title: { type: "string" },
                    tags: { type: "array", items: { type: "string" } },
                    validFrom: { type: "string" },
                    validTo: { type: "string" },
                    isPinned: { type: "boolean" }
                  },
                  required: ["key", "content"]
                }
              }
            },
            required: [],
          },
        },
        {
          name: "munin_retrieve_memory",
          description: "Retrieve a memory by its unique key from the current Munin Context Core. IMPORTANT: Call this as an MCP tool, NOT as a shell command.",
          inputSchema: {
            type: "object",
            properties: {
              projectId: { type: "string", description: "Optional. The Munin Context Core ID." },
              key: { type: "string", description: "Unique identifier" },
            },
            required: ["key"],
          },
        },
        {
          name: "munin_search_memories",
          description: "Hybrid 6-signal search (keyword + semantic + named-entity + quoted-phrase + recency + pinned). QUERY TIPS to lift recall: (1) Wrap exact strings in double quotes — e.g., `\"Project Munin v1.3\"` — to trigger quoted-phrase boost (+0.25); (2) Include capitalized names (people, products, places) for name-entity boost (+0.15); (3) Use `filters.since`/`before` for temporal scoping (relative strings supported: 'yesterday', 'last week', '7 days ago'). Returns token-efficient GraphRAG context with mermaid graph. IMPORTANT: Call as MCP tool.",
          inputSchema: {
            type: "object",
            properties: {
              projectId: { type: "string", description: "Optional. The Munin Context Core ID." },
              query: { type: "string", description: "Search query. Tip: wrap exact phrases in quotes for boost; capitalize entity names." },
              tags: { type: "array", items: { type: "string" }, description: "Filter results to memories containing these tags" },
              tagMode: { type: "string", enum: ["or", "and"], description: "Tag combination: 'or' (any match) or 'and' (all match). Default: 'or'." },
              filters: {
                type: "object",
                description: "Temporal filter on memory createdAt. Supports ISO-8601 dates AND relative strings: 'yesterday', 'last week', 'last month', 'last year', '7 days ago', '3 weeks ago', etc.",
                properties: {
                  since: { type: "string", description: "Memories created on/after this date (e.g., 'last week', '2026-04-01')" },
                  before: { type: "string", description: "Memories created on/before this date" }
                }
              },
              topK: { type: "number", description: "Max results to return (default: 10, max: 50)" },
              offset: { type: "number", description: "Pagination offset for fetching more results (default: 0)" },
              includeTotal: { type: "boolean", description: "If true, includes total count in response (default: false)" },
            },
            required: ["query"],
          },
        },
        {
          name: "munin_list_memories",
          description: "List all memories with pagination support. IMPORTANT: Call this as an MCP tool, NOT as a shell command.",
          inputSchema: {
            type: "object",
            properties: {
              projectId: { type: "string", description: "Optional. The Munin Context Core ID." },
              limit: { type: "number", description: "Max results to return (default: 10, max: 100)" },
              offset: { type: "number", description: "Pagination offset (default: 0)" },
            },
            required: [],
          },
        },
        {
          name: "munin_recent_memories",
          description: "Get the most recently updated memories. IMPORTANT: Call this as an MCP tool, NOT as a shell command.",
          inputSchema: {
            type: "object",
            properties: {
              projectId: { type: "string", description: "Optional. The Munin Context Core ID." },
              limit: { type: "number" },
            },
            required: [],
          },
        },
        {
          name: "munin_share_memory",
          description: "Share one or more memories to other projects owned by the same user. The target project must share the same Hash Key to read encrypted content. IMPORTANT: Call this as an MCP tool, NOT as a shell command.",
          inputSchema: {
            type: "object",
            properties: {
              projectId: { type: "string", description: "Optional. The source project ID." },
              memoryIds: {
                type: "array",
                items: { type: "string" },
                description: "Array of memory IDs to share",
              },
              targetProjectIds: {
                type: "array",
                items: { type: "string" },
                description: "Array of target project IDs to share memories into",
              },
            },
            required: ["memoryIds", "targetProjectIds"],
          },
        },
        {
          name: "munin_get_project_info",
          description: "Get current project metadata including E2EE status, tier features, and limits. CRITICAL: Before storing or retrieving memories in an E2EE project, verify the encryption key is set correctly. Shows whether MUNIN_ENCRYPTION_KEY is configured. IMPORTANT: Call this as an MCP tool, NOT as a shell command.",
          inputSchema: {
            type: "object",
            properties: {
              projectId: { type: "string", description: "Optional. Defaults to active project." },
            },
            required: [],
          },
        },
        {
          name: "munin_versions",
          description: "List all versions of a memory (version history). Use this to review past changes before rolling back. IMPORTANT: Call this as an MCP tool, NOT as a shell command.",
          inputSchema: {
            type: "object",
            properties: {
              projectId: { type: "string", description: "Optional. Defaults to active project." },
              key: { type: "string", description: "Memory key (provide this OR id, not both)" },
              id: { type: "string", description: "Memory ID (provide this OR key, not both)" },
            },
            required: [],
          },
        },
        {
          name: "munin_rollback",
          description: "Rollback a memory to a previous version. Run munin_versions first to find the version number. IMPORTANT: Call this as an MCP tool, NOT as a shell command.",
          inputSchema: {
            type: "object",
            properties: {
              projectId: { type: "string", description: "Optional. Defaults to active project." },
              key: { type: "string", description: "Memory key (provide this OR id, not both)" },
              id: { type: "string", description: "Memory ID (provide this OR key, not both)" },
              version: { type: "number", description: "The version number to rollback to (required)" },
            },
            required: ["version"],
          },
        },
        {
          name: "munin_diff_memory",
          description: "Compare two specific versions of the same memory. Returns a diff showing what changed between v1 and v2. IMPORTANT: Call this as an MCP tool, NOT as a shell command.",
          inputSchema: {
            type: "object",
            properties: {
              projectId: { type: "string", description: "Optional. Defaults to active project." },
              key: { type: "string", description: "Memory key" },
              v1: { type: "number", description: "First version number" },
              v2: { type: "number", description: "Second version number" },
            },
            required: ["key", "v1", "v2"],
          },
        },
        {
          name: "munin_delete_memory",
          description: "Permanently delete a memory by key or id from the current Munin Context Core. This action is destructive and cannot be undone — the memory and all its version history are removed. Use with caution. IMPORTANT: Call this as an MCP tool, NOT as a shell command.",
          inputSchema: {
            type: "object",
            properties: {
              projectId: { type: "string", description: "Optional. Defaults to active project." },
              key: { type: "string", description: "Memory key (provide this OR id, not both)" },
              id: { type: "string", description: "Memory ID (provide this OR key, not both)" }
            },
            required: [],
          }
        },
        {
          name: "munin_acknowledge_setup",
          description: "Acknowledge that you have read the latest Munin setup guide. Call this AFTER reading the setup guide URL provided in any ERR_STALE_PROTOCOL response. Subsequent write actions (store, share) will then proceed without setup-version errors. Pass the version exactly as shown in the remediation hint.",
          inputSchema: {
            type: "object",
            properties: {
              projectId: { type: "string", description: "Optional. Defaults to active project." },
              version: { type: "string", description: "Setup version in ISO date format (YYYY-MM-DD), exactly as shown in the ERR_STALE_PROTOCOL remediation hint." }
            },
            required: ["version"]
          }
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const args = request.params.arguments || {};
      // Priority: explicit arg > env var > CWD .env file
      const projectId = (args.projectId as string) || resolveProjectId();

      if (!projectId) {
        throw new Error(
          "projectId is required. Ensure MUNIN_PROJECT is set in .env or .env.local in your project directory, or passed as an argument."
        );
      }

      // Remove projectId from args before sending as payload
      const { projectId: _ignored, ...payload } = args;

      // Auto-inject encryptionKey from env if not explicitly provided
      const encryptionKey = (args.encryptionKey as string) || resolveEncryptionKey();
      const enrichedPayload = encryptionKey ? { ...payload, encryptionKey } : payload;

      let result;

      switch (request.params.name) {
        case "munin_store_memory":
          result = await client.store(projectId, enrichedPayload);
          break;
        case "munin_retrieve_memory":
          result = await client.retrieve(projectId, enrichedPayload);
          break;
        case "munin_search_memories":
          result = await client.search(projectId, enrichedPayload);
          break;
        case "munin_list_memories":
          result = await client.list(projectId, enrichedPayload);
          break;
        case "munin_recent_memories":
          result = await client.recent(projectId, enrichedPayload);
          break;
        case "munin_share_memory":
          result = await client.invoke(projectId, "share", enrichedPayload);
          break;
        case "munin_diff_memory":
          result = await client.invoke(projectId, "diff", enrichedPayload);
          break;
        case "munin_get_project_info": {
          const caps = await client.capabilities();
          result = {
            ok: true,
            encryptionKeyConfigured: !!encryptionKey,
            ...caps,
          };
          break;
        }
        case "munin_versions":
          if (!hasSingleIdentifier(args)) {
            throw new Error("munin_versions requires exactly one of 'key' or 'id' to identify the target memory.");
          }
          result = await client.invoke(projectId, "versions", { key: args.key, id: args.id });
          break;
        case "munin_rollback":
          if (!hasSingleIdentifier(args)) {
            throw new Error("munin_rollback requires exactly one of 'key' or 'id' to identify the target memory.");
          }
          if (typeof args.version !== "number") {
            throw new Error("munin_rollback requires a numeric 'version' to roll back to.");
          }
          result = await client.invoke(projectId, "rollback", { key: args.key, id: args.id, version: args.version });
          break;
        case "munin_delete_memory":
          if (!hasSingleIdentifier(args)) {
            throw new Error("munin_delete_memory requires exactly one of 'key' or 'id' to identify the target memory.");
          }
          result = await client.invoke(projectId, "delete", { key: args.key, id: args.id });
          break;
        case "munin_acknowledge_setup":
          result = await client.invoke(projectId, "acknowledge_setup", { version: args.version });
          break;
        default:
          throw new Error(`Unknown tool: ${request.params.name}`);
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      const errObj = safeError(error);
      return {
        content: [
          {
            type: "text",
            text: `Error executing tool: ${JSON.stringify(errObj)}`,
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}

export async function startMcpServer() {
  const env = loadCliEnv();
  const server = createMcpServerInstance(env);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Munin MCP Server running on stdio");
}
