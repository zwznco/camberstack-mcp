/**
 * The stdio entry (`npm start`): every tool listed, with no database, secrets or Google login. Directory
 * inspectors run servers this way: Glama wraps `pnpm run start` in mcp-proxy, which speaks stdio to the
 * child. Production serves HTTP (`node dist/server.js`, the Docker CMD). A tool call needs a connected
 * Google account, which only the hosted server has, so each one answers with where to connect. stdout is
 * the protocol channel here: nothing else may write to it.
 */
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { buildServer } from "./tools.js";

const CONNECT = "This stdio mode only lists Camberstack's tools. To use them, add the hosted server "
  + "https://camberstack.io/mcp to your MCP client and connect your Google Ads account (https://camberstack.io/docs).";

// Every tool, Merchant Center included: this is what the directories list.
buildServer(() => { throw new Error(CONNECT); }, undefined, undefined, { merchant: true })
  .connect(new StdioServerTransport())
  .catch((e) => { console.error(e); process.exit(1); });
