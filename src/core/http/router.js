/**
 * Router berbasis pohon segmen (radix per segmen path).
 * - Pencocokan deterministik: segmen statis selalu diprioritaskan atas parameter.
 * - Conflicting parameter names and duplicate routes are rejected at registration (fail fast).
 */
class Node {
  statics = new Map();
  /** @type {{ name: string, node: Node } | null} */
  param = null;
  /** @type {Map<string, Function[]>} */
  handlers = new Map();
}

function segmentsOf(pathname) {
  const segments = [];
  for (const raw of pathname.split('/')) {
    if (!raw) continue;
    try {
      segments.push(decodeURIComponent(raw));
    } catch {
      return null;
    }
  }
  return segments;
}

export class Router {
  #root = new Node();

  add(method, path, handlers) {
    if (handlers.length === 0) throw new Error(`Route ${method} ${path} has no handler`);
    let node = this.#root;

    for (const segment of path.split('/').filter(Boolean)) {
      if (segment.startsWith(':')) {
        const name = segment.slice(1);
        if (node.param && node.param.name !== name) {
          throw new Error(`Conflicting parameters ":${name}" vs ":${node.param.name}" in ${path}`);
        }
        node.param ??= { name, node: new Node() };
        node = node.param.node;
      } else {
        if (!node.statics.has(segment)) node.statics.set(segment, new Node());
        node = node.statics.get(segment);
      }
    }

    if (node.handlers.has(method)) throw new Error(`Duplicate route: ${method} ${path}`);
    node.handlers.set(method, handlers);
    return this;
  }

  get(path, ...handlers) {
    return this.add('GET', path, handlers);
  }

  post(path, ...handlers) {
    return this.add('POST', path, handlers);
  }

  patch(path, ...handlers) {
    return this.add('PATCH', path, handlers);
  }

  put(path, ...handlers) {
    return this.add('PUT', path, handlers);
  }

  delete(path, ...handlers) {
    return this.add('DELETE', path, handlers);
  }

  /**
   * @returns {{ handlers: Function[] | undefined, params: Record<string, string>, allowed: string[] } | null}
   *   null = unknown path; handlers undefined = known path but unsupported method.
   */
  match(method, pathname) {
    const segments = segmentsOf(pathname);
    if (!segments) return null;

    const params = {};
    const node = this.#walk(this.#root, segments, 0, params);
    if (!node) return null;

    const lookup = method === 'HEAD' && !node.handlers.has('HEAD') ? 'GET' : method;
    return { handlers: node.handlers.get(lookup), params, allowed: [...node.handlers.keys()] };
  }

  #walk(node, segments, index, params) {
    if (index === segments.length) return node.handlers.size > 0 ? node : null;

    const segment = segments[index];
    const staticChild = node.statics.get(segment);
    if (staticChild) {
      const found = this.#walk(staticChild, segments, index + 1, params);
      if (found) return found;
    }
    if (node.param) {
      const found = this.#walk(node.param.node, segments, index + 1, params);
      if (found) {
        params[node.param.name] = segment;
        return found;
      }
    }
    return null;
  }
}
