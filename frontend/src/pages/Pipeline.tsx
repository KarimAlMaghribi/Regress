import { useState, useEffect, useCallback } from 'react';
import ReactFlow, {
  ReactFlowProvider,
  Controls,
  Background,
  Node,
  Edge,
  NodeProps,
  addEdge,
} from 'reactflow';
import StageScorePanel from '../components/StageScorePanel';
import FinalPromptInfo from '../components/FinalPromptInfo';
import NodeEditPanel from '../components/NodeEditPanel';
import EdgeEditPanel from '../components/EdgeEditPanel';
import NodeCreationDialog, { NodeCreationData } from '../components/NodeCreationDialog';
import useAutoConnect from '../hooks/useAutoConnect';
import useSimulation from '../hooks/useSimulation';
import { useParams } from 'react-router-dom';
import { Box, Button, Drawer, Typography, useMediaQuery } from '@mui/material';
import { toast } from 'react-hot-toast';
import { PipelineGraph } from '../types/PipelineGraph';
import PromptNode from '../components/PromptNode';
import { buildGraphFromElements } from '../utils/graph';
import dagre from 'dagre';
import '../styles/pipeline.css';

type PromptType =
  | 'TriggerPrompt'
  | 'AnalysisPrompt'
  | 'FollowUpPrompt'
  | 'DecisionPrompt'
  | 'FinalPrompt'
  | 'MetaPrompt';

export default function Pipeline() {
  const { id } = useParams<{ id?: string }>();
  const pipelineId = id ?? 'active';

  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [graph, setGraph] = useState<PipelineGraph | null>(null);
  const [stageScores, setStageScores] = useState<{ id: string; name: string; score: number }[]>([]);
  const [finalInfo, setFinalInfo] = useState<{ score: number; label: string }>({ score: 0, label: '' });
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<Edge | null>(null);
  const isMobile = useMediaQuery('(max-width:1024px)');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [creationType, setCreationType] = useState<PromptType | null>(null);

  const layoutNodes = useCallback((ns: Node[], es: Edge[]): Node[] => {
    const g = new dagre.graphlib.Graph();
    g.setDefaultEdgeLabel(() => ({}));
    g.setGraph({ rankdir: 'TB', nodesep: 200, ranksep: 120 });
    ns.forEach(n => g.setNode(n.id, { width: 150, height: 50 }));
    es.forEach(e => g.setEdge(e.source, e.target));
    dagre.layout(g);
    return ns.map(n => {
      const coord = g.node(n.id);
      return coord ? { ...n, position: { x: coord.x, y: coord.y } } : n;
    });
  }, []);

  const handleLayout = useCallback(() => {
    setNodes(ns => layoutNodes(ns, edges));
  }, [edges, layoutNodes]);

  const autoConnect = useAutoConnect(nodes, edges);
  const repeatNode = (id: string) => {
    setNodes(ns => {
      const orig = ns.find(n => n.id === id);
      if (!orig) return ns;
      const newNode = {
        ...orig,
        id: crypto.randomUUID(),
        position: { x: orig.position.x + 40, y: orig.position.y + 40 },
      };
      setSelectedNode(newNode);
      setSelectedEdge(null);
      if (isMobile) setSidebarOpen(true);
      return ns.concat(newNode);
    });
  };

  const NodeWrapper = (props: NodeProps<any>) => (
      <div
          onClick={() => {
            setSelectedNode(props);
            setSelectedEdge(null);
            if (isMobile) setSidebarOpen(true);
          }}
          style={{ width: '100%', height: '100%' }}
      >
        <PromptNode data={props.data} onRepeat={() => repeatNode(props.id)} />
      </div>
  );

  const nodeTypesCustom = { default: NodeWrapper };
  const simulate = useSimulation(
      graph || { nodes: [], edges: [], stages: [], finalScoring: { scoreFormula: '0', labelRules: [] } },
  );

  const runPipeline = () => {
    const g: PipelineGraph = buildGraphFromElements(nodes, edges);
    setGraph(g);
    fetch('/pipeline/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(g),
    })
    .then(r => r.json())
    .then(res => {
      setNodes(ns =>
          ns.map(n => {
            const h = res.history.find((h: any) => h.prompt_id === (n.data as any).promptId);
            return h
                ? {
                  ...n,
                  data: {
                    ...n.data,
                    score: h.score,
                    answer: h.answer,
                    source: h.answer_source,
                  },
                }
                : n;
          }),
      );
      const stageMap = g.stages.map(s => {
        const rel = res.history.filter((h: any) => s.promptIds.includes(h.prompt_id));
        const sc = rel.length ? rel.reduce((a: number, h: any) => a + (h.score || 0), 0) / rel.length : 0;
        return { id: s.id, name: s.name, score: sc };
      });
      setStageScores(stageMap);
      setFinalInfo({ score: res.score, label: res.label });
      toast.success(`🏁 Pipeline finished – ${res.label} (score ${res.score.toFixed(2)})`);
    });
  };

  const savePipeline = () => {
    const graph: PipelineGraph = buildGraphFromElements(nodes, edges);
    fetch('/pipelines', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: pipelineId, data: graph }),
    }).then(() => toast.success('💾 Pipeline gespeichert'));
  };


  const createNode = useCallback(
    (type: PromptType, data: Partial<NodeCreationData> = {}) => {
      let pos = { x: 0, y: 0 };
      if (selectedNode) {
        pos = {
          x: selectedNode.position.x + 40,
          y: selectedNode.position.y + 40,
        };
      }
      const newNode: Node = {
        id: crypto.randomUUID(),
        type: 'default',
        position: pos,
        data: {
          label: data.label ?? type,
          type,
          text: data.text ?? '',
          weight: data.weight ?? 1,
          confidenceThreshold: data.confidenceThreshold ?? 0.5,
        },
      };
      const autoEdges = autoConnect(newNode, selectedNode);
      const newEdges = [...edges, ...autoEdges];
      const newNodes = [...nodes, newNode];
      setEdges(newEdges);
      setNodes(layoutNodes(newNodes, newEdges));
      setSelectedNode(newNode);
      setSelectedEdge(null);
      if (isMobile) setSidebarOpen(true);
    },
    [isMobile, nodes, edges, autoConnect, layoutNodes, selectedNode],
  );


  const onEdgeClick = useCallback(
    (_: React.MouseEvent, edge: Edge) => {
      setSelectedEdge(edge);
      setSelectedNode(null);
      if (isMobile) setSidebarOpen(true);
    },
    [isMobile],
  );

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      setSelectedNode(node);
      setSelectedEdge(null);
      if (isMobile) setSidebarOpen(true);
    },
    [isMobile],
  );

  const handleSaveNode = (
      id: string,
      data: {
        label?: string;
        weight?: number;
        confidenceThreshold?: number;
        text?: string;
        promptId?: string | number;
      },
  ) => {
    setNodes(ns =>
        ns.map(n =>
            n.id === id
                ? { ...n, data: { ...n.data, ...data } }
                : n,
        ),
    );
  };

  const handleSaveEdge = (id: string, type: string, condition: string) => {
    setEdges(es =>
        es.map(e =>
            e.id === id
                ? {
                  ...e,
                  data: { ...e.data, edge_type: type, label: condition },
                  animated: ['onTrue', 'onScore'].includes(type),
                  label: type === 'onScore' ? condition : undefined,
                }
                : e,
        ),
    );
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Delete') {
        if (selectedEdge) {
          setEdges(prev => prev.filter(ed => ed.id !== selectedEdge.id));
          setSelectedEdge(null);
        } else if (selectedNode) {
          const remainingNodes = nodes.filter(n => n.id !== selectedNode.id);
          const remainingEdges = edges.filter(
            e => e.source !== selectedNode.id && e.target !== selectedNode.id,
          );
          setEdges(remainingEdges);
          setNodes(layoutNodes(remainingNodes, remainingEdges));
          setSelectedNode(null);
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selectedEdge, selectedNode, nodes, edges, layoutNodes]);

  useEffect(() => {
    setNodes(ns =>
        ns.map((n, i) => ({
          ...n,
          style: i === simulate.currentStep ? { boxShadow: '0 0 0 2px red' } : {},
        })),
    );
  }, [simulate.currentStep]);

  useEffect(() => {
    fetch(`/pipelines/${pipelineId}`)
      .then(r => r.json())
      .then((g: PipelineGraph) => {
        const ns: Node[] = g.nodes.map(n => ({
          id: n.id,
          data: {
            label: (n as any).metadata?.label ?? n.text,
            text: n.text,
            type: n.type,
            weight: n.weight,
            confidenceThreshold: n.confidenceThreshold,
            promptId: n.id,
          },
          position: { x: Math.random() * 400, y: Math.random() * 400 },
          type: 'default',
        }));
        const es: Edge[] = g.edges.map(e => ({
          id: `${e.source}-${e.target}`,
          source: e.source,
          target: e.target,
          animated: ['onTrue', 'onScore'].includes(e.type ?? 'always'),
          label: e.condition ?? undefined,
          data: { edge_type: e.type, label: e.condition },
        }));
        setEdges(es);
        setNodes(layoutNodes(ns, es));
      });
  }, [pipelineId, layoutNodes]);

  return (
      <Box>
        <Box sx={{ mb: 1 }}>
          <Button variant="contained" onClick={runPipeline} sx={{ mr: 1 }}>▶️ Run Pipeline</Button>
          <Button variant="outlined" onClick={savePipeline}>💾 Save</Button>
          <Button onClick={handleLayout} sx={{ ml: 1 }}>📐 Layout</Button>
          <Button onClick={simulate.play} sx={{ ml: 1 }}>▶️ Simulate</Button>
          <Button onClick={simulate.pause}>⏸️ Pause</Button>
          <Button onClick={simulate.prev}>⏮️ Prev</Button>
          <Button onClick={simulate.next}>⏭️ Next</Button>
        </Box>
      )}
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: '120px 1fr 300px',
          height: 'calc(100vh - 64px)',
          gap: 2,
          '@media (max-width: 1024px)': {
            gridTemplateColumns: '1fr',
          },
        }}
      >
        {!isMobile && (
          <aside
            className="palette"
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '0.5rem',
              overflowY: 'auto',
              height: '100%',
              padding: '0.5rem',
              borderRight: '1px solid rgba(0,0,0,0.12)',
            }}
          >
            {[
              ['TriggerPrompt', '🟡 Trigger'],
              ['AnalysisPrompt', '🟢 Analysis'],
              ['FollowUpPrompt', '🔁 Follow‑Up'],
              ['DecisionPrompt', '⚖️ Decision'],
              ['FinalPrompt', '🟣 Final'],
              ['MetaPrompt', '⚙️ Meta'],
            ].map(([t, l]) => (
              <div
                key={t}
                className="palette-item"
                role="listitem"
                aria-label={l}
                tabIndex={0}
                onClick={() => {
                  setCreationType(t as PromptType);
                  setPaletteOpen(false);
                  setSidebarOpen(false);
                }}
              >
                {l}
              </div>
            ))}
          </aside>
        )}
        <Box sx={{ flexGrow: 1 }} tabIndex={0} role="region" aria-label="Canvas">
          <ReactFlowProvider>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              deleteKeyCode={46}
              connectable={true}
              onConnect={params => setEdges(es => addEdge(params, es))}
              onEdgeClick={onEdgeClick}
              onNodeClick={onNodeClick}
              style={{ width: '100%', height: '100%' }}
            >
              <Controls />
              <Background color="#aaa" gap={16} />
            </ReactFlow>
          </ReactFlowProvider>
        </Box>
        {!isMobile && (
          <Box sx={{ width: 300 }}>
            {selectedNode && (
              <NodeEditPanel
                key={selectedNode.id}
                node={selectedNode}
                onSave={handleSaveNode}
              />
            )}
            {selectedEdge && (
              <EdgeEditPanel edge={selectedEdge} onSave={handleSaveEdge} />
            )}
            {!selectedNode && !selectedEdge && (
              <Typography>Wähle ein Element</Typography>
            )}
          </Box>
        </Box>
      </Box>
      {creationType && (
        <NodeCreationDialog
          open={true}
          type={creationType}
          onCancel={() => setCreationType(null)}
          onCreate={data => {
            createNode(creationType, data);
            setCreationType(null);
          }}
        />
      )}
      {isMobile && (
        <>
          <Drawer anchor="left" open={paletteOpen} onClose={() => setPaletteOpen(false)}>
            <aside
              style={{
                width: 120,
                display: 'flex',
                flexDirection: 'column',
                gap: '0.5rem',
                overflowY: 'auto',
                height: '100%',
                padding: '0.5rem',
                borderRight: '1px solid rgba(0,0,0,0.12)',
              }}
            >
              {[
                ['TriggerPrompt', '🟡 Trigger'],
                ['AnalysisPrompt', '🟢 Analysis'],
                ['FollowUpPrompt', '🔁 Follow‑Up'],
                ['DecisionPrompt', '⚖️ Decision'],
                ['FinalPrompt', '🟣 Final'],
                ['MetaPrompt', '⚙️ Meta'],
              ].map(([t, l]) => (
                <div
                  key={t}
                  className="palette-item"
                  role="listitem"
                  aria-label={l}
                  tabIndex={0}
                  onClick={() => {
                    setCreationType(t as PromptType);
                    setPaletteOpen(false);
                    setSidebarOpen(false);
                  }}
                >
                  {l}
                </div>
              ))}
            </aside>
          </Drawer>
          <Drawer anchor="right" open={sidebarOpen} onClose={() => setSidebarOpen(false)}>
            <Box sx={{ width: 300, p: 1 }}>
              {selectedNode && (
                <NodeEditPanel
                  key={selectedNode.id}
                  node={selectedNode}
                  onSave={handleSaveNode}
                />
              )}
              {selectedEdge && (
                <EdgeEditPanel edge={selectedEdge} onSave={handleSaveEdge} />
              )}
              {!selectedNode && !selectedEdge && (
                <Typography sx={{ p: 1 }}>Wähle ein Element</Typography>
              )}
            </Box>
          </Drawer>
        </>
      )}
    </Box>
  );
}
