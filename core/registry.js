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
    this.hiddenCount = new Map(); // name -> how many plugins hide it (refcount)
    this.interceptors = []; // {priority, seq, fn} sorted: lower priority first, then registration order
    this.#interceptorSeq = 0;
  }

  #interceptorSeq;

  // Intercept every tool call before its handler runs. fn({tool, raw, args}) — tool is
  // the exposed (prefixed) name, raw the unprefixed one — returns:
  //   nothing            -> continue to the next interceptor unchanged
  //   {args}             -> continue with replaced args
  //   {result}           -> stop: return this MCP result as the call's success
  //   {error: "msg"}     -> stop: return an isError result
  // Replacing a call = intercepting it and returning the result of registry.call(other).
  // Lower priority runs first (default 100). A throwing interceptor is skipped.
  // Returns unsubscribe.
  intercept(fn, priority = 100) {
    const entry = { priority, seq: this.#interceptorSeq++, fn };
    this.interceptors.push(entry);
    this.interceptors.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
    return () => {
      const i = this.interceptors.indexOf(entry);
      if (i >= 0) this.interceptors.splice(i, 1);
    };
  }

  #isHidden(name) {
    return (this.hiddenCount.get(name) ?? 0) > 0;
  }

  // Hide a tool from MCP sessions (tools/list and calls). registry.call — the REST
  // path — still works: hiding shapes the agent surface, it is not auth. Refcounted:
  // the tool reappears when every hider has unhidden. Hiding a name that is not
  // registered yet is fine; it applies when the tool arrives.
  hide(name) {
    name = this.prefix + name;
    const n = (this.hiddenCount.get(name) ?? 0) + 1;
    this.hiddenCount.set(name, n);
    if (n > 1) return;
    for (const handles of this.servers.values()) {
      handles.get(name)?.remove();
      handles.delete(name);
    }
  }

  unhide(name) {
    name = this.prefix + name;
    const n = this.hiddenCount.get(name) ?? 0;
    if (n > 1) { this.hiddenCount.set(name, n - 1); return; }
    this.hiddenCount.delete(name);
    const def = this.tools.get(name);
    if (!def) return;
    for (const [server, handles] of this.servers) {
      if (!handles.has(name)) handles.set(name, this.#register(server, name, def));
    }
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
    if (this.#isHidden(name)) return;
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
    for (const [name, def] of this.tools) {
      if (!this.#isHidden(name)) handles.set(name, this.#register(server, name, def));
    }
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
    args = args ?? {};
    try {
      const raw = this.prefix && name.startsWith(this.prefix) ? name.slice(this.prefix.length) : name;
      for (const { fn } of [...this.interceptors]) {
        let r;
        try { r = await fn({ tool: name, raw, args }); } catch { continue; } // interceptor must not break calls
        if (!r) continue;
        if (r.error !== undefined) { error = String(r.error); return { isError: true, content: [{ type: 'text', text: `${name}: ${r.error}` }] }; }
        if (r.result !== undefined) return r.result;
        if (r.args !== undefined) args = r.args;
      }
      return await def.handler(args);
    } catch (e) {
      error = e.message;
      return { isError: true, content: [{ type: 'text', text: `${name}: ${e.message}` }] };
    } finally {
      for (const fn of this.callHooks) {
        try { fn({ tool: name, args, error }); } catch { /* observer must not break calls */ }
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
