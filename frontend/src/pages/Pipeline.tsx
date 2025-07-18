import React, { useCallback, useEffect, useState } from 'react';
import ReactFlow, {
  MiniMap,
  Controls,
  Background,
  Handle,
  Position,
  Node,
  Edge,
  NodeProps,
  EdgeProps,
  useNodesState,
  useEdgesState,
  addEdge,
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
} from 'reactflow';
import 'reactflow/dist/style.css';
import useUndo from 'use-undo';
import { Box, Drawer, TextField, Button } from '@mui/material';
import PageHeader from '../components/PageHeader';
import { examplePipeline, PromptNode, Edge as PipelineEdge } from '../types/PipelineGraph';
import { useNavigate } from 'react-router-dom';

function toFlowNodes(nodes: PromptNode[]): Node<PromptNode>[] {
  return nodes.map((n, i) => ({
    id: n.id,
    type: n.type,
    data: n,
    position: { x: i * 150, y: 0 },
  }));
}

type FlowEdge = Edge<EdgeData> & PipelineEdge & { id: string };

function toFlowEdges(edges: PipelineEdge[]): FlowEdge[] {
  return edges.map((e, i) => ({
    id: e.id ?? `e-${i}`,
    source: e.source,
    target: e.target,
    type: e.type,
    data: { type: e.type, label: e.condition, onChange: () => {} },
  }));
}

const emojiMap: Record<PromptNode['type'], string> = {
  TriggerPrompt: '🚦',
  AnalysisPrompt: '🔍',
  FollowUpPrompt: '🔁',
  DecisionPrompt: '⚖️',
  FinalPrompt: '🎯',
  MetaPrompt: '🧩',
};

function PromptNodeComp({ data }: NodeProps<PromptNode>) {
  const fullText = data?.text || '';
  const text = fullText.length > 40 ? fullText.slice(0, 37) + '…' : fullText;
  return (
    <Box sx={{ p: 1, border: 1, borderRadius: 1, bgcolor: 'background.paper', textAlign: 'center' }}>
      <Handle type="target" position={Position.Top} />
      {emojiMap[data.type]} {text}
      <Handle type="source" position={Position.Bottom} />
    </Box>
  );
}

const nodeTypes = {
  TriggerPrompt: PromptNodeComp,
  AnalysisPrompt: PromptNodeComp,
  FollowUpPrompt: PromptNodeComp,
  DecisionPrompt: PromptNodeComp,
  FinalPrompt: PromptNodeComp,
  MetaPrompt: PromptNodeComp,
};

const edgeColor: Record<string, string> = {
  onTrue: '#2e7d32',
  onFalse: '#d32f2f',
  onScore: '#ed6c02',
  always: '#9e9e9e',
};

type EdgeData = { type?: string; label?: string; onChange: (id: string, value: string) => void };
interface EditableEdgeProps extends EdgeProps<EdgeData> {}

const EditableEdge = ({ id, sourceX, sourceY, targetX, targetY, markerEnd, data }: EditableEdgeProps) => {
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY });
  return (
    <>
      <BaseEdge path={path} markerEnd={markerEnd} style={{ stroke: edgeColor[data?.type || 'always'] }} />
      <EdgeLabelRenderer>
        <foreignObject width={80} height={30} x={labelX - 40} y={labelY - 15} style={{ overflow: 'visible' }}>
          <input
            style={{ width: '100%', textAlign: 'center', border: '1px solid #ccc', background: 'transparent' }}
            value={data?.label || ''}
            onChange={e => data?.onChange(id, e.target.value)}
          />
        </foreignObject>
      </EdgeLabelRenderer>
    </>
  );
};

const edgeTypes = { default: EditableEdge };

interface PipelineProps {
  initial?: typeof examplePipeline;
}

export default function Pipeline({ initial = examplePipeline }: PipelineProps) {
  const navigate = useNavigate();
  const [graphState, { set: setGraph, undo, redo }] = useUndo(initial);
  const { nodes: initialNodes, edges: initialEdges } = graphState.present;
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<PromptNode>>(toFlowNodes(initialNodes));
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdge>(toFlowEdges(initialEdges));
  const [selection, setSelection] = useState<{ node?: string; edge?: string }>({});

  useEffect(() => {
    setNodes(toFlowNodes(initialNodes));
    setEdges(toFlowEdges(initialEdges));
  }, [initialNodes, initialEdges]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === 'z') undo();
      if (e.ctrlKey && e.key === 'y') redo();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [undo, redo]);

  const save = async () => {
    await fetch('/pipelines', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(graphState.present),
    });
  };
  const run = async () => {
    const res = await fetch('/pipeline/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(graphState.present),
    });
    const data = await res.json();
    navigate(`/result/${data.id}`);
  };

  const onConnect = useCallback(
    (params: any) => {
      setEdges(eds =>
        addEdge(
          { ...params, data: { type: 'always', label: '', onChange: handleLabelChange } } as any,
          eds,
        ),
      );
    },
    [setEdges],
  );

  const handleLabelChange = useCallback(
    (id: string, value: string) => {
      setEdges(eds => eds.map(e => (e.id === id ? { ...e, data: { ...e.data, label: value, onChange: handleLabelChange } } : e)));
    },
    [setEdges],
  );

  useEffect(() => {
    setGraph({ nodes, edges });
  }, [nodes, edges, setGraph]);

  return (
    <Box sx={{ height: 'calc(100vh - 64px)' }}>
      <PageHeader
        title="Pipeline"
        actions={
          <>
            <Button onClick={save}>📤 Speichern</Button>
            <Button onClick={run}>▶️ Testlauf</Button>
          </>
        }
      />
      <ReactFlow
        nodes={nodes}
        edges={edges.map(e => ({ ...e, data: { ...e.data, onChange: handleLabelChange } }))}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onSelectionChange={sel => setSelection({ node: sel.nodes?.[0]?.id, edge: sel.edges?.[0]?.id })}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
      >
        <MiniMap />
        <Controls />
        <Background variant="dots" />
      </ReactFlow>
      <Drawer anchor="right" open={!!selection.node || !!selection.edge} onClose={() => setSelection({})}>
        <Box sx={{ p: 2, width: 240 }}>
          {selection.node &&
            nodes
              .filter(n => n.id === selection.node)
              .map(n => (
                <TextField
                  key={n.id}
                  label="Text"
                  value={n.data.text}
                  onChange={e => setNodes(ns => ns.map(no => (no.id === n.id ? { ...no, data: { ...no.data, text: e.target.value } } : no)))}
                  fullWidth
                  multiline
                />
              ))}
          {selection.edge &&
            edges
              .filter(e => e.id === selection.edge)
              .map(e => (
                <TextField
                  key={e.id}
                  label="Label"
                  value={e.data?.label || ''}
                  onChange={ev => handleLabelChange(e.id, ev.target.value)}
                  fullWidth
                />
              ))}
        </Box>
      </Drawer>
    </Box>
  );
}
