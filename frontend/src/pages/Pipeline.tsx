import { useState, useEffect, useCallback, useRef } from 'react';
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
import useSimulation from '../hooks/useSimulation';
import { useParams } from 'react-router-dom';
import { Box, Button, Drawer, Typography, useMediaQuery } from '@mui/material';
import { toast } from 'react-hot-toast';
import { PipelineGraph } from '../types/PipelineGraph';
import PromptNode from '../components/PromptNode';
import { buildGraphFromElements } from '../utils/graph';
import dagre from 'dagre';
import '../styles/pipeline.css';

export default function Pipeline() {
  const { id } = useParams<{ id?: string }>();
  const pipelineId = id ?? 'active';

  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [rfInstance, setRfInstance] = useState<any>(null);
  const [graph, setGraph] = useState<PipelineGraph | null>(null);
  const [stageScores, setStageScores] = useState<{ id: string; name: string; score: number }[]>([]);
  const [finalInfo, setFinalInfo] = useState<{ score: number; label: string }>({ score: 0, label: '' });
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<Edge | null>(null);
  const isMobile = useMediaQuery('(max-width:1024px)');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const lastNodeRef = useRef<Node | null>(null);
  const repeatNode = (id: string) => {
    setNodes(ns => {
      const orig = ns.find(n => n.id === id);
      if (!orig) return ns;
      const newNode = {
        ...orig,
        id: `n_${Date.now()}`,
        position: { x: orig.position.x + 40, y: orig.position.y + 40 },
      };
      lastNodeRef.current = newNode;
      return ns.concat(newNode);
    });
  };
  const NodeWrapper = ({ id, data }: NodeProps<any>) => (
    <PromptNode data={data} onRepeat={() => repeatNode(id)} />
  );
  const nodeTypesCustom = { default: NodeWrapper };
  const nodeTypes = nodeTypesCustom;
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
        toast.success(
          `\ud83c\udfc1 Pipeline finished \u2013 ${res.label} (score ${res.score.toFixed(2)})`,
        );
      });
  };

  const savePipeline = () => {
    const graph: PipelineGraph = buildGraphFromElements(nodes, edges);
    fetch('/pipelines', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: pipelineId, data: graph }),
    }).then(() => toast.success('\ud83d\udcbe Pipeline gespeichert'));
  };

  const handleLayout = () => {
    const g = new dagre.graphlib.Graph();
    g.setDefaultEdgeLabel(() => ({}));
    g.setGraph({ rankdir: 'TB', nodesep: 200, ranksep: 120 });
    nodes.forEach(n => {
      g.setNode(n.id, { width: 150, height: 50 });
    });
    edges.forEach(e => g.setEdge(e.source, e.target));
    dagre.layout(g);
    setNodes(ns =>
      ns.map(n => {
        const coord = g.node(n.id);
        return coord
          ? { ...n, position: { x: coord.x, y: coord.y } }
          : n;
      }),
    );
  };

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const type = e.dataTransfer.getData('application/reactflow');
      if (!type || !rfInstance) return;
      let pos = rfInstance.project({ x: e.clientX, y: e.clientY });
      if (lastNodeRef.current) {
        pos = {
          x: lastNodeRef.current.position.x + 40,
          y: lastNodeRef.current.position.y + 40,
        };
      }
      const newNode: Node = {
        id: `n_${Date.now()}`,
        type: 'default',
        position: pos,
        data: {
          label: type,
          type,
          text: '',
          weight: 1,
          confidenceThreshold: 0.5,
        },
      };
      setNodes(ns => ns.concat(newNode));
      if (lastNodeRef.current) {
        const newEdge: Edge = {
          id: `${lastNodeRef.current.id}-${newNode.id}`,
          source: lastNodeRef.current.id,
          target: newNode.id,
          type: 'always',
          data: { edge_type: 'always' },
        };
        setEdges(es => es.concat(newEdge));
      }
      lastNodeRef.current = newNode;
    },
    [rfInstance],
  );

  const onEdgeClick = (_: React.MouseEvent, edge: Edge) => {
    setSelectedEdge(edge);
    setSelectedNode(null);
    if (isMobile) setSidebarOpen(true);
  };

  const onNodeClick = (_: React.MouseEvent, node: Node) => {
    setSelectedNode(node);
    setSelectedEdge(null);
    if (isMobile) setSidebarOpen(true);
  };

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
      if (e.key === 'Delete' && selectedEdge) {
        setEdges(prev => prev.filter(ed => ed.id !== selectedEdge.id));
        setSelectedEdge(null);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selectedEdge]);

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
        setNodes(ns);
        setEdges(es);
      });
  }, [pipelineId]);

  return (
    <Box>
      <Box sx={{ mb: 1 }}>
        <Button className="btn-run" variant="contained" onClick={runPipeline} sx={{ mr: 1 }}>
          ▶️ Run Pipeline
        </Button>
        <Button className="btn-save" variant="outlined" onClick={savePipeline}>
          💾 Save
        </Button>
        <Button onClick={handleLayout} sx={{ ml: 1 }}>📐 Layout</Button>
        <Button onClick={simulate.play} sx={{ ml: 1 }}>▶️ Simulate</Button>
        <Button onClick={simulate.pause}>⏸️ Pause</Button>
        <Button onClick={simulate.prev}>⏮️ Prev</Button>
        <Button onClick={simulate.next}>⏭️ Next</Button>
      </Box>
      <StageScorePanel stages={stageScores} />
      <FinalPromptInfo
        score={finalInfo.score}
        label={finalInfo.label}
        rules={graph?.finalScoring.labelRules || []}
      />
      {isMobile && (
        <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
          <Button variant="outlined" onClick={() => setPaletteOpen(true)} aria-label="Open Palette" tabIndex={0}>
            Palette
          </Button>
          <Button variant="outlined" onClick={() => setSidebarOpen(true)} aria-label="Open Sidebar" tabIndex={0}>
            Panel
          </Button>
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
                draggable
                role="listitem"
                aria-label={l}
                tabIndex={0}
                onDragStart={e => {
                  e.dataTransfer.setData('application/reactflow', t);
                  e.dataTransfer.effectAllowed = 'move';
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
              onInit={setRfInstance}
              deleteKeyCode={46}
              onDragOver={e => e.preventDefault()}
              onDrop={handleDrop}
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
            {selectedNode && <NodeEditPanel node={selectedNode} onSave={handleSaveNode} />}
            {selectedEdge && <EdgeEditPanel edge={selectedEdge} onSave={handleSaveEdge} />}
            {!selectedNode && !selectedEdge && (
              <Typography>Wähle ein Element</Typography>
            )}
          </Box>
        )}
      </Box>
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
                  draggable
                  onDragStart={e => {
                    e.dataTransfer.setData('application/reactflow', t);
                    e.dataTransfer.effectAllowed = 'move';
                  }}
                >
                  {l}
                </div>
              ))}
            </aside>
          </Drawer>
          <Drawer anchor="right" open={sidebarOpen} onClose={() => setSidebarOpen(false)}>
            <Box sx={{ width: 300, p: 1 }}>
              {selectedNode && <NodeEditPanel node={selectedNode} onSave={handleSaveNode} />}
              {selectedEdge && <EdgeEditPanel edge={selectedEdge} onSave={handleSaveEdge} />}
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
