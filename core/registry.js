// Central tool registry. MCP sessions come and go (one McpServer per session),
// plugins add and remove tools at run time; the registry is the single source both
// sides sync against. Listeners are live McpServer instances.
export class ToolRegistry {
  // prefix (TOOL_PREFIX) namespaces every tool at registration: several containers
  // can sit behind one MCP aggregator without name collisions. External callers
  // (MCP, REST /api/tool/<name>) use the prefixed name.
  constructor(prefix = '') {
    this.prefix = prefix;
    this.tools = new Map(); // name -> {description, inputSchema, handler}
    this.servers = new Map(); // McpServer -> Map(name -> RegisteredTool handle)
    this.callHooks = new Set(); // observers of every tool call
  }

  // Observe tool calls: fn({tool, args, error?}) fires after each call. Returns unsubscribe.
  onCall(fn) {
    this.callHooks.add(fn);
    return () => this.callHooks.delete(fn);
  }

  add(name, { description, inputSchema = {} }, handler) {
    name = this.prefix + name;
    if (this.tools.has(name)) throw new Error(`tool already registered: ${name}`);
    const def = { description, inputSchema, handler };
    this.tools.set(name, def);
    for (const [server, handles] of this.servers) {
      handles.set(name, this.#register(server, name, def));
    }
  }

  remove(name) {
    name = this.prefix + name;
    if (!this.tools.delete(name)) return;
    for (const handles of this.servers.values()) {
      handles.get(name)?.remove();
      handles.delete(name);
    }
  }

  // Wire every current and future tool into a session's McpServer.
  attach(server) {
    const handles = new Map();
    for (const [name, def] of this.tools) handles.set(name, this.#register(server, name, def));
    this.servers.set(server, handles);
  }

  detach(server) {
    this.servers.delete(server);
  }

  // Run a tool directly (the REST /api/tool/<name> path uses this; MCP sessions
  // go through the same wrapper via #register).
  async call(name, args = {}) {
    const def = this.tools.get(name);
    if (!def) return { isError: true, content: [{ type: 'text', text: `no tool ${name}` }] };
    return this.#invoke(name, def, args);
  }

  async #invoke(name, def, args) {
    let error;
    try {
      return await def.handler(args ?? {});
    } catch (e) {
      error = e.message;
      return { isError: true, content: [{ type: 'text', text: `${name}: ${e.message}` }] };
    } finally {
      for (const fn of this.callHooks) {
        try { fn({ tool: name, args: args ?? {}, error }); } catch { /* observer must not break calls */ }
      }
    }
  }

  #register(server, name, def) {
    return server.registerTool(
      name,
      { description: def.description, inputSchema: def.inputSchema },
      (args) => this.#invoke(name, def, args),
    );
  }
}
