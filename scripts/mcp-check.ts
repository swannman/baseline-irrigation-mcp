/**
 * Spawns the built server over stdio and exercises the MCP protocol: list tools,
 * then call a couple of read tools. Validates wiring, not data correctness.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: {
    ...process.env,
    BASELINE_USERNAME: process.env.BASELINE_USERNAME ?? "",
    BASELINE_PASSWORD: process.env.BASELINE_PASSWORD ?? "",
  },
});

const client = new Client({ name: "mcp-check", version: "0.0.0" });

async function main() {
  await client.connect(transport);

  const { tools } = await client.listTools();
  console.log(
    "tools:",
    tools.map((t) => t.name).join(", "),
  );

  const whoami = await client.callTool({ name: "baseline_whoami", arguments: {} });
  console.log("\nbaseline_whoami ->");
  console.log((whoami.content as any[])[0].text);

  const alarms = await client.callTool({
    name: "baseline_get_alarms",
    arguments: {},
  });
  console.log("\nbaseline_get_alarms ->");
  console.log((alarms.content as any[])[0].text.slice(0, 600));

  await client.close();
  console.log("\nMCP protocol check passed.");
}

main().catch((err) => {
  console.error("MCP check failed:", err);
  process.exit(1);
});
