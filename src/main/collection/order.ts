// SPDX-License-Identifier: AGPL-3.0-only
// Deploy-order computation for a collection plan. Pure.
// Phase ascending first; inside a phase, "X before Y" edges put X earlier (Y wins file conflicts).
// Topological sort is stable on original index; cycles are broken by dropping back edges.

/** Directed edge: `from` must deploy before `to`. Indices refer to collection.mods. */
export interface OrderEdge {
  from: number;
  to: number;
}

export interface OrderResult {
  /** Original indices in deploy order. */
  sequence: number[];
  /** Edges dropped because they formed a cycle. */
  droppedEdges: OrderEdge[];
}

function buildAdjacency(count: number, edges: OrderEdge[]): number[][] {
  const adjacency: number[][] = Array.from({ length: count }, () => []);
  for (const { from, to } of edges) {
    const list = adjacency[from];
    if (list !== undefined && !list.includes(to)) list.push(to);
  }
  for (const list of adjacency) list.sort((a, b) => a - b);
  return adjacency;
}

/** DFS in index order; every edge into a node still on the stack closes a cycle and is removed. */
function removeBackEdges(nodes: number[], adjacency: number[][]): OrderEdge[] {
  const state = new Map<number, 'active' | 'done'>();
  const dropped: OrderEdge[] = [];
  const visit = (node: number): void => {
    state.set(node, 'active');
    const targets = adjacency[node] ?? [];
    for (const target of [...targets]) {
      const seen = state.get(target);
      if (seen === 'active') {
        targets.splice(targets.indexOf(target), 1);
        dropped.push({ from: node, to: target });
      } else if (seen === undefined) {
        visit(target);
      }
    }
    state.set(node, 'done');
  };
  for (const node of nodes) if (!state.has(node)) visit(node);
  return dropped;
}

/** Kahn's algorithm, always taking the lowest original index that is ready. */
function stableTopoSort(nodes: number[], adjacency: number[][]): number[] {
  const indegree = new Map<number, number>(nodes.map((n) => [n, 0]));
  for (const n of nodes) {
    for (const t of adjacency[n] ?? []) indegree.set(t, (indegree.get(t) ?? 0) + 1);
  }
  const ready = nodes.filter((n) => indegree.get(n) === 0);
  const out: number[] = [];
  while (ready.length > 0) {
    ready.sort((a, b) => a - b);
    const next = ready.shift();
    if (next === undefined) break;
    out.push(next);
    for (const t of adjacency[next] ?? []) {
      const remaining = (indegree.get(t) ?? 0) - 1;
      indegree.set(t, remaining);
      if (remaining === 0) ready.push(t);
    }
  }
  if (out.length !== nodes.length) {
    throw new Error(`deploy order: ${nodes.length - out.length} mod(s) left in a cycle after cycle removal`);
  }
  return out;
}

/**
 * Orders `phases.length` mods. Edges between different phases, self-edges and edges with
 * out-of-range indices are ignored (phase always wins).
 */
export function computeDeployOrder(phases: number[], edges: OrderEdge[]): OrderResult {
  const count = phases.length;
  const samePhase = edges.filter(
    (e) =>
      e.from !== e.to &&
      phases[e.from] !== undefined &&
      phases[e.from] === phases[e.to],
  );
  const adjacency = buildAdjacency(count, samePhase);
  const byPhase = new Map<number, number[]>();
  phases.forEach((phase, index) => {
    const group = byPhase.get(phase) ?? [];
    group.push(index);
    byPhase.set(phase, group);
  });
  const sequence: number[] = [];
  const droppedEdges: OrderEdge[] = [];
  for (const phase of [...byPhase.keys()].sort((a, b) => a - b)) {
    const nodes = byPhase.get(phase) ?? [];
    droppedEdges.push(...removeBackEdges(nodes, adjacency));
    sequence.push(...stableTopoSort(nodes, adjacency));
  }
  return { sequence, droppedEdges };
}
