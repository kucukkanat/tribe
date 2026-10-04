/** All diagnostics go to stderr: stdout is reserved for the MCP stdio protocol. */
export function log(...args: unknown[]): void {
  const parts = args.map((a) => (a instanceof Error ? (a.stack ?? a.message) : typeof a === "string" ? a : JSON.stringify(a)));
  process.stderr.write(`[tribe-mcp] ${parts.join(" ")}\n`);
}
