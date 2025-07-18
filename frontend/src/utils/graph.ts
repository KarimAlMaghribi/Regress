import { Node, Edge } from 'reactflow';
import { PipelineGraph } from '../types/PipelineGraph';

export function buildGraphFromElements(nodes: Node[], edges: Edge[]): PipelineGraph {
  const n = nodes.map(node => ({
    id: (node.data as any).promptId ?? node.id,
    type: (node.data as any).type,
    text: (node.data as any).label,
    weight: (node.data as any).weight ?? 1,
    confidenceThreshold: (node.data as any).confidenceThreshold,
  }));
  const e = edges.map(edge => ({
    source: (edge as any).source,
    target: (edge as any).target,
    type: (edge.data as any)?.edge_type ?? 'always',
    condition: (edge.data as any)?.label ?? edge.label ?? null,
  }));
  return { nodes: n, edges: e, stages: [], finalScoring: { scoreFormula: '0', labelRules: [] } };
}
