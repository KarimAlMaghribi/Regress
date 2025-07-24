// src/utils/layout.ts
import ELK from 'elkjs/lib/elk.bundled.js';
import { Node, Edge } from 'reactflow';
import { Port } from '../types/Port';

// ELK so initialisieren, dass das WASM aus dem public‑Verzeichnis geholt wird:
const elk = new ELK({
  workerUrl: `${process.env.PUBLIC_URL}/elk.bundled.wasm`,
});

export async function layoutELK(
    nodes: Node[],
    edges: Edge[],
): Promise<Node[]> {
  // Graph‑Definition für ELK
  const graph: any = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.spacing.nodeNode': '50',
      'elk.layered.spacing.nodeNodeBetweenLayers': '80',
      'elk.layered.nodePlacement.bk.fixedAlignment': 'BALANCED',
      'elk.edgeRouting': 'ORTHOGONAL',
      // Damit Ports an den Knotenrändern anliegen
      'elk.layered.portAlignment': 'INTERNAL',
      'elk.portAlignment': 'SINGLE_SOURCE',
    },
    children: nodes.map((n) => {
      const inPorts: Port[] =
          (n.data as any).inPorts?.length
              ? (n.data as any).inPorts
              : [{ id: 'in1', side: 'left' }];
      const outPorts: Port[] =
          (n.data as any).outPorts?.length
              ? (n.data as any).outPorts
              : [{ id: 'out1', side: 'right' }];

      return {
        id: n.id,
        width: (n.width ?? 180) + 20,
        height: Math.max(40, 24 * Math.max(inPorts.length, outPorts.length)),
        ports: [
          ...inPorts.map((p) => ({
            id: `${n.id}-${p.id}-in`,
            side: 'WEST',
          })),
          ...outPorts.map((p) => ({
            id: `${n.id}-${p.id}-out`,
            side: 'EAST',
          })),
        ],
      };
    }),
    edges: edges.map((e) => ({
      id: e.id,
      sources: [`${e.source}-${e.sourceHandle}-out`],
      targets: [`${e.target}-${e.targetHandle}-in`],
    })),
  };

  // tatsächlich layouten
  const res = await elk.layout(graph);

  // ermittelte x/y zurück in die React‑Flow‑Nodes
  return nodes.map((n) => {
    const c = res.children?.find((c: any) => c.id === n.id);
    return c
        ? { ...n, position: { x: c.x ?? 0, y: c.y ?? 0 } }
        : n;
  });
}
