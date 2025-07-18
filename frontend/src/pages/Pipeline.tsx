import { useState, useEffect } from 'react';
import ReactFlow, {
  ReactFlowProvider,
  Controls,
  Background,
  Node,
  Edge,
} from 'reactflow';
import { useParams } from 'react-router-dom';
import { PipelineGraph } from '../types/PipelineGraph';

export default function Pipeline() {
  const { id } = useParams<{ id?: string }>();
  const pipelineId = id ?? 'active';

  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [rfInstance, setRfInstance] = useState<any>(null);

  useEffect(() => {
    fetch(`/pipelines/${pipelineId}`)
      .then(r => r.json())
      .then((g: PipelineGraph) => {
        const ns: Node[] = g.nodes.map(n => ({
          id: n.id,
          data: { label: n.text, type: n.type },
          position: { x: Math.random() * 400, y: Math.random() * 400 },
          type: 'default',
        }));
        const es: Edge[] = g.edges.map(e => ({
          id: `${e.source}-${e.target}`,
          source: e.source,
          target: e.target,
          animated: ['onTrue', 'onScore'].includes(e.type ?? 'always'),
          label: e.condition ?? undefined,
        }));
        setNodes(ns);
        setEdges(es);
      });
  }, [pipelineId]);

  return (
    <ReactFlowProvider>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onInit={setRfInstance}
        deleteKeyCode={46}
        style={{ width: '100%', height: '100%' }}
      >
        <Controls />
        <Background color="#aaa" gap={16} />
      </ReactFlow>
    </ReactFlowProvider>
  );
}
