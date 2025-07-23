import ELK from 'elkjs/lib/elk.bundled.js';
import { Node, Edge } from 'reactflow';
import { Port } from '../types/Port';

const elk = new ELK();

export async function layoutELK(nodes: Node[], edges: Edge[]): Promise<Node[]> {
  const g = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'DOWN',
      'elk.layered.spacing.nodeNodeBetweenLayers': '80',
      'elk.layered.nodePlacement.bk.fixedAlignment': 'CENTER',
      'elk.edgeRouting': 'ORTHOGONAL',
    },
    children: nodes.map(n => {
      const inPorts: Port[] = (n.data as any).inPorts ?? [{ id: 'in', side: 'left' }];
      const outPorts: Port[] = (n.data as any).outPorts ?? [{ id: 'out', side: 'right' }];
      return {
        id: n.id,
        width: 180,
        height: Math.max(40, 24 * Math.max(inPorts.length, outPorts.length)),
        ports: [
          ...inPorts.map(p => ({ id: `${n.id}-${p.id}-in`, side: 'WEST' })),
          ...outPorts.map(p => ({ id: `${n.id}-${p.id}-out`, side: 'EAST' })),
        ],
      };
    }),
    edges: edges.map(e => ({
      id: e.id,
      sources: [`${e.source}-${e.sourceHandle ?? 'out'}-out`],
      targets: [`${e.target}-${e.targetHandle ?? 'in'}-in`],
    })),
  } as any;

  const res = await elk.layout(g);
  return nodes.map(n => {
    const child = res.children?.find((c: any) => c.id === n.id);
    if (!child) return n;
    return { ...n, position: { x: child.x, y: child.y } };
  });
}
