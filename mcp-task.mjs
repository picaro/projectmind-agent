import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

async function callToolJson(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.map((p) => p.text ?? JSON.stringify(p)).join("\n") || "";
  if (result.isError) throw new Error(text);
  return JSON.parse(text);
}

const url = new URL(process.env.IMEMORY_MCP_URL);
const transport = new StreamableHTTPClientTransport(url, {
  requestInit: { headers: { Authorization: `Bearer ${process.env.IMEMORY_API_KEY}` } },
});
const client = new Client({ name: "task-script", version: "0.0.1" });
await client.connect(transport);

const action = process.argv[2] ?? "list";

if (action === "list") {
  const jobs = await callToolJson(client, "listAgentJobs", { limit: 30 });
  console.log(JSON.stringify(jobs, null, 2));
} else if (action === "context") {
  const ctx = await callToolJson(client, "getTaskContext", {
    taskId: "bb125a8a-2078-4f9a-ab15-5347e1fa587c",
    projectSlug: "imemory",
  });
  console.log(JSON.stringify(ctx, null, 2));
}

await client.close();
