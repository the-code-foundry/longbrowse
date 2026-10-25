// Post-processing filters over Playwright's ariaSnapshot YAML (2-space indent per
// level). Pure text/indent logic: no browser calls, fully unit-testable.

const INTERACTIVE = new Set([
  'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox',
  'switch', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'slider',
  'spinbutton', 'tab', 'listbox',
]);

function parse(yaml) {
  const nodes = [];
  const stack = []; // index per depth
  for (const line of yaml.split('\n')) {
    if (!line.trim()) continue;
    const indent = line.match(/^ */)[0].length;
    const depth = Math.floor(indent / 2);
    const node = { line, depth, parent: depth > 0 ? stack[depth - 1] : -1 };
    stack[depth] = nodes.length;
    nodes.push(node);
  }
  return nodes;
}

function role(node) {
  const m = node.line.trim().match(/^- ([a-z]+)/i);
  return m ? m[1].toLowerCase() : '';
}

function ancestors(nodes, i) {
  const out = [];
  for (let p = nodes[i].parent; p >= 0; p = nodes[p].parent) out.unshift(p);
  return out;
}

function descendants(nodes, i, maxExtra) {
  const out = [];
  const base = nodes[i].depth;
  for (let j = i + 1; j < nodes.length && nodes[j].depth > base; j++) {
    if (nodes[j].depth - base <= maxExtra) out.push(j);
  }
  return out;
}

// opts: {query, query_role, max_depth, child_depth, interactive, max_lines}
export function filterSnapshot(yaml, opts = {}) {
  let nodes = parse(yaml);

  if (opts.max_depth !== undefined) {
    nodes = nodes.filter((n) => n.depth < opts.max_depth);
    // parents indices now stale for queries below; recompute from kept lines
    nodes = parse(nodes.map((n) => n.line).join('\n'));
  }

  if (opts.interactive) {
    const keep = new Set();
    nodes.forEach((n, i) => {
      if (INTERACTIVE.has(role(n))) {
        keep.add(i);
        for (const a of ancestors(nodes, i)) keep.add(a);
      }
    });
    nodes = nodes.filter((_, i) => keep.has(i));
    nodes = parse(nodes.map((n) => n.line).join('\n'));
  }

  let out;
  if (opts.query || opts.query_role) {
    const rx = opts.query?.match(/^\/(.*)\/$/);
    const test = (n) => {
      if (opts.query_role && role(n) !== opts.query_role.toLowerCase()) return false;
      if (rx) return new RegExp(rx[1], 'i').test(n.line);
      if (opts.query) return n.line.toLowerCase().includes(opts.query.toLowerCase());
      return true;
    };
    const blocks = [];
    const seen = new Set(); // a hit inside an earlier hit's block is not its own block
    nodes.forEach((n, i) => {
      if (!test(n) || seen.has(i)) return;
      const idx = [...ancestors(nodes, i), i, ...descendants(nodes, i, opts.child_depth ?? 1)];
      idx.forEach((j) => seen.add(j));
      blocks.push(idx.map((j) => nodes[j].line).join('\n'));
      if (blocks.length >= 20) blocks.push('… (more matches, refine the query)');
    });
    out = blocks.length ? blocks.slice(0, 21).join('\n---\n') : '(no match)';
  } else {
    out = nodes.map((n) => n.line).join('\n');
  }

  if (opts.max_lines !== undefined) {
    const lines = out.split('\n');
    if (lines.length > opts.max_lines) {
      out = lines.slice(0, opts.max_lines).join('\n') + `\n… (+${lines.length - opts.max_lines} lines truncated)`;
    }
  }
  return out;
}

// Screenshot box helpers. Two modes: corners {x1,y1,x2,y2} or centered
// {x,y,width,height}. Returns a playwright clip, clamped into [0,0,pw,ph].
export function computeBox(a, pw, ph) {
  const corners = [a.x1, a.y1, a.x2, a.y2].every((v) => v !== undefined);
  const centered = [a.x, a.y, a.width, a.height].every((v) => v !== undefined);
  if (corners === centered) throw new Error('give either x1,y1,x2,y2 or x,y,width,height');
  let x, y, w, h;
  if (corners) {
    x = Math.min(a.x1, a.x2); y = Math.min(a.y1, a.y2);
    w = Math.abs(a.x2 - a.x1); h = Math.abs(a.y2 - a.y1);
  } else {
    w = a.width; h = a.height;
    x = a.x - w / 2; y = a.y - h / 2;
  }
  x = Math.max(0, Math.min(x, pw - 1));
  y = Math.max(0, Math.min(y, ph - 1));
  w = Math.max(1, Math.min(w, pw - x));
  h = Math.max(1, Math.min(h, ph - y));
  return { x, y, width: w, height: h };
}
