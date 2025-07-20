import { useState, useEffect, useCallback } from 'react';
import ReactFlow, {
  ReactFlowProvider,
  Controls,
  Background,
  Node,
  Edge,
  NodeProps,
} from 'reactflow';
import StageScorePanel from '../components/StageScorePanel';
import EdgeConditionPopover from '../components/EdgeConditionPopover';
import FinalPromptInfo from '../components/FinalPromptInfo';
import useSimulation from '../hooks/useSimulation';
import { useParams } from 'react-router-dom';
import { Box, Button } from '@mui/material';
import { toast } from 'react-hot-toast';
import { PipelineGraph } from '../types/PipelineGraph';
import PromptNode from '../components/PromptNode';
import { buildGraphFromElements } from '../utils/graph';
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
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<Edge | null>(null);
  const repeatNode = (id: string) => {
    setNodes(ns => {
      const orig = ns.find(n => n.id === id);
      if (!orig) return ns;
      return ns.concat({
        ...orig,
        id: `n_${Date.now()}`,
        position: { x: orig.position.x + 40, y: orig.position.y + 40 },
      });
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

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const type = e.dataTransfer.getData('application/reactflow');
      if (!type || !rfInstance) return;
      const pos = rfInstance.project({ x: e.clientX, y: e.clientY });
      setNodes(ns =>
        ns.concat({
          id: `n_${Date.now()}`,
          type: 'default',
          position: pos,
          data: { label: type, type, promptId: type },
        }),
      );
    },
    [rfInstance],
  );

  const onEdgeClick = (event: React.MouseEvent, edge: Edge) => {
    setSelectedEdge(edge);
    setAnchorEl(event.currentTarget as HTMLElement);
  };

  const handleSaveEdge = (type: string, condition: string) => {
    setEdges(es =>
      es.map(e =>
        e.id === selectedEdge?.id
          ? { ...e, data: { ...e.data, edge_type: type, label: condition }, animated: ['onTrue', 'onScore'].includes(type), label: condition }
          : e,
      ),
    );
  };

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
          data: { label: n.text, type: n.type, promptId: n.id, confidenceThreshold: n.confidenceThreshold },
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
        <Button onClick={simulate.play} sx={{ ml: 1 }}>▶️ Simulate</Button>
        <Button onClick={simulate.pause}>⏸️ Pause</Button>
        <Button onClick={simulate.prev}>⏮️ Prev</Button>
        <Button onClick={simulate.next}>⏭️ Next</Button>
      </Box>
      <StageScorePanel stages={stageScores} />
      <FinalPromptInfo score={finalInfo.score} label={finalInfo.label} rules={graph?.finalScoring.labelRules || []} />
      <Box sx={{ display: 'flex', height: 'calc(100vh - 64px - 48px)' }}>
        <aside className="palette" style={{ width: 120, padding: 8 }}>
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
              onDragStart={e => {
                e.dataTransfer.setData('application/reactflow', t);
                e.dataTransfer.effectAllowed = 'move';
              }}
            >
              {l}
            </div>
          ))}
        </aside>
        <Box sx={{ flexGrow: 1 }}>
          <ReactFlowProvider>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onInit={setRfInstance}
              deleteKeyCode={46}
              onDragOver={e => e.preventDefault()}
              onDrop={handleDrop}
              onEdgeClick={onEdgeClick}
              style={{ width: '100%', height: '100%' }}
            >
              <Controls />
              <Background color="#aaa" gap={16} />
            </ReactFlow>
          </ReactFlowProvider>
          {selectedEdge && (
            <EdgeConditionPopover
              edge={selectedEdge}
              anchorEl={anchorEl}
              open
              onClose={() => setSelectedEdge(null)}
              onSave={handleSaveEdge}
            />
          )}
        </Box>
      </Box>
    </Box>
  );
}
