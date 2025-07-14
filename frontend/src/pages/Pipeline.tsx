import React, { useState, useMemo, useCallback } from 'react';
import {
  Box,
  Paper,
  Typography,
  Card,
  CardContent,
  Button,
  Accordion,
  AccordionSummary,
  AccordionDetails,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import PictureAsPdfIcon from '@mui/icons-material/PictureAsPdf';
import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubbleOutline';
import ReactFlow, {
  MiniMap,
  Controls,
  Handle,
  Position,
  NodeProps,
  Connection,
  ReactFlowProvider,
  Node,
  Edge,
} from 'react-flow-renderer';
import { DragDropContext, Droppable, Draggable, DropResult } from 'react-beautiful-dnd';
import dagre from 'dagre';
import PageHeader from '../components/PageHeader';

interface Step { id: string; label: string; type: 'pdf' | 'prompt'; }
interface Stage { id: string; name: string; steps: Step[]; }
interface Prompt { id: number; text: string; }
interface PromptGroup { id: number; name: string; promptIds: number[]; }

type NodeData = { label: string; type: 'pdf' | 'prompt' };

const CardNode = ({ data }: NodeProps<NodeData>) => (
  <Card variant="outlined" sx={{ minWidth: 170, textAlign: 'center' }}>
    <Handle type="target" position={Position.Top} />
    <CardContent sx={{ p: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 1 }}>
      {data.type === 'pdf' ? (
        <PictureAsPdfIcon fontSize="small" color="error" />
      ) : (
        <ChatBubbleOutlineIcon fontSize="small" color="primary" />
      )}
      <Typography variant="body2">{data.label}</Typography>
    </CardContent>
    <Handle type="source" position={Position.Bottom} />
  </Card>
);

const nodeTypes = { card: CardNode };

function applyLayout(nodes: Node<NodeData>[], edges: Edge[]) {
  const dagreGraph = new dagre.graphlib.Graph();
  dagreGraph.setDefaultEdgeLabel(() => ({}));
  dagreGraph.setGraph({ rankdir: 'LR' });

  nodes.forEach(n => dagreGraph.setNode(n.id, { width: 170, height: 48 }));
  edges.forEach(e => dagreGraph.setEdge(e.source, e.target));

  dagre.layout(dagreGraph);

  return nodes.map(n => {
    const { x, y } = dagreGraph.node(n.id);
    n.position = { x, y };
    return n;
  });
}

export default function PipelineFlow() {
  const [pdfIds, setPdfIds] = useState<number[]>([]);
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [groups, setGroups] = useState<PromptGroup[]>([]);
  const [pipeline, setPipeline] = useState<Stage[]>([
    { id: 'pdf', name: 'PDF Stage', steps: [] },
    { id: 'prompt', name: 'Prompt Stage', steps: [] },
  ]);

  const togglePdf = (id: number) => {
    setPipeline(p => {
      const idx = p.findIndex(s => s.id === 'pdf');
      if (idx === -1) return p;
      const stage = p[idx];
      const exists = stage.steps.some(s => s.id === `pdf-${id}`);
      const steps = exists
        ? stage.steps.filter(s => s.id !== `pdf-${id}`)
        : [...stage.steps, { id: `pdf-${id}`, label: `PDF ${id}`, type: 'pdf' }];
      const np = [...p];
      np[idx] = { ...stage, steps };
      return np;
    });
  };

  const addAllPdfs = () => {
    setPipeline(p => {
      const idx = p.findIndex(s => s.id === 'pdf');
      if (idx === -1) return p;
      const stage = p[idx];
      const steps = [...stage.steps];
      pdfIds.forEach(id => {
        if (!steps.some(s => s.id === `pdf-${id}`)) {
          steps.push({ id: `pdf-${id}`, label: `PDF ${id}`, type: 'pdf' });
        }
      });
      const np = [...p];
      np[idx] = { ...stage, steps };
      return np;
    });
  };

  const clearPdfs = () => {
    setPipeline(p => p.map(s => (s.id === 'pdf' ? { ...s, steps: [] } : s)));
  };

  const togglePrompt = (id: number) => {
    const pr = prompts.find(p => p.id === id);
    if (!pr) return;
    setPipeline(p => {
      const idx = p.findIndex(s => s.id === 'prompt');
      if (idx === -1) return p;
      const stage = p[idx];
      const exists = stage.steps.some(s => s.id === `prompt-${id}`);
      const steps = exists
        ? stage.steps.filter(s => s.id !== `prompt-${id}`)
        : [...stage.steps, { id: `prompt-${id}`, label: pr.text, type: 'prompt' }];
      const np = [...p];
      np[idx] = { ...stage, steps };
      return np;
    });
  };

  const selectAllGroup = (gid: number) => {
    const ids = groups.find(g => g.id === gid)?.promptIds || [];
    setPipeline(p => {
      const idx = p.findIndex(s => s.id === 'prompt');
      if (idx === -1) return p;
      const stage = p[idx];
      const steps = [...stage.steps];
      ids.forEach(id => {
        const pr = prompts.find(pr => pr.id === id);
        if (!pr) return;
        if (!steps.some(s => s.id === `prompt-${id}`)) {
          steps.push({ id: `prompt-${id}`, label: pr.text, type: 'prompt' });
        }
      });
      const np = [...p];
      np[idx] = { ...stage, steps };
      return np;
    });
  };

  const deselectAllGroup = (gid: number) => {
    const ids = groups.find(g => g.id === gid)?.promptIds || [];
    setPipeline(p => {
      const idx = p.findIndex(s => s.id === 'prompt');
      if (idx === -1) return p;
      const stage = p[idx];
      const steps = stage.steps.filter(s => !ids.includes(Number(s.id.replace('prompt-', ''))));
      const np = [...p];
      np[idx] = { ...stage, steps };
      return np;
    });
  };

  const onDragEnd = (result: DropResult) => {
    if (!result.destination) return;
    const gId = Number(result.source.droppableId);
    if (gId !== Number(result.destination.droppableId)) return;
    setGroups(gs =>
      gs.map(g => {
        if (g.id === gId) {
          const list = Array.from(g.promptIds);
          const [removed] = list.splice(result.source.index, 1);
          list.splice(result.destination.index, 0, removed);
          return { ...g, promptIds: list };
        }
        return g;
      }),
    );
  };

  React.useEffect(() => {
    fetch('http://localhost:8083/texts')
      .then(r => r.json())
      .then((list: { id: number }[]) => setPdfIds(list.map(i => i.id)))
      .catch(() => undefined);
    fetch('http://localhost:8082/prompts')
      .then(r => r.json())
      .then(setPrompts)
      .catch(() => undefined);
    fetch('http://localhost:8082/prompt-groups')
      .then(r => r.json())
      .then((list: any[]) =>
        list.map(g => ({ id: g.id, name: g.name, promptIds: g.prompt_ids as number[] })),
      )
      .then(setGroups)
      .catch(() => undefined);
  }, []);

  const { nodes, edges } = useMemo(() => {
    const ns: Node<NodeData>[] = [];
    const es: Edge[] = [];

    pipeline.forEach((stage, i) => {
      stage.steps.forEach(step => {
        ns.push({ id: step.id, type: 'card', data: { label: step.label, type: step.type }, position: { x: 0, y: 0 } });
      });
      if (i < pipeline.length - 1) {
        stage.steps.forEach(a => {
          pipeline[i + 1].steps.forEach(b => {
            es.push({ id: `${a.id}-${b.id}`, source: a.id, target: b.id, animated: true, style: { stroke: '#6C5DD3' } });
          });
        });
      }
    });

    return { nodes: applyLayout(ns, es), edges: es };
  }, [pipeline]);

  const onConnect = useCallback((c: Connection) => {
    console.log('connect', c);
  }, []);

  const pdfStage = pipeline.find(s => s.id === 'pdf');
  const promptStage = pipeline.find(s => s.id === 'prompt');

  const selectedPdfs = pdfStage?.steps.map(s => Number(s.id.replace('pdf-', ''))) || [];
  const selectedPrompts = promptStage?.steps.map(s => Number(s.id.replace('prompt-', ''))) || [];

  return (
    <Box>
      <PageHeader title="Pipeline" breadcrumb={[{ label: 'Dashboard', to: '/' }, { label: 'Pipeline' }]} />
      <Paper sx={{ p: 2, mb: 2 }}>
        <Typography variant="h6" gutterBottom>
          PDF Stage
        </Typography>
        <Box sx={{ mb: 2 }}>
          {pdfIds.map(id => {
            const selected = selectedPdfs.includes(id);
            return (
              <Card
                key={id}
                onClick={() => togglePdf(id)}
                sx={{ mb: 1, bgcolor: selected ? 'action.selected' : 'background.paper', cursor: 'pointer' }}
              >
                <CardContent sx={{ p: 1 }}>
                  <Typography variant="body2">PDF {id}</Typography>
                </CardContent>
              </Card>
            );
          })}
        </Box>
        <Button size="small" onClick={addAllPdfs} sx={{ mr: 1 }}>
          Alle rein
        </Button>
        <Button size="small" onClick={clearPdfs}>
          Leeren
        </Button>
      </Paper>
      <Paper sx={{ p: 2, mb: 2 }}>
        <Typography variant="h6" gutterBottom>
          Prompt Stage
        </Typography>
        <DragDropContext onDragEnd={onDragEnd}>
          {groups.map(g => (
            <Accordion key={g.id} defaultExpanded>
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <Typography>{g.name}</Typography>
                <Box sx={{ ml: 'auto' }}>
                  <Button
                    size="small"
                    onClick={e => {
                      e.stopPropagation();
                      selectAllGroup(g.id);
                    }}
                  >
                    Alle auswählen
                  </Button>
                  <Button
                    size="small"
                    onClick={e => {
                      e.stopPropagation();
                      deselectAllGroup(g.id);
                    }}
                  >
                    Alle abwählen
                  </Button>
                </Box>
              </AccordionSummary>
              <AccordionDetails>
                <Droppable droppableId={String(g.id)}>
                  {prov => (
                    <Box ref={prov.innerRef} {...prov.droppableProps}>
                      {g.promptIds.map((pid, idx) => {
                        const p = prompts.find(pr => pr.id === pid);
                        if (!p) return null;
                        const selected = selectedPrompts.includes(pid);
                        return (
                          <Draggable key={pid} draggableId={String(pid)} index={idx}>
                            {drag => (
                              <Card
                                ref={drag.innerRef}
                                {...drag.draggableProps}
                                {...drag.dragHandleProps}
                                onClick={() => togglePrompt(pid)}
                                sx={{ mb: 1, bgcolor: selected ? 'action.selected' : 'background.paper', cursor: 'pointer' }}
                              >
                                <CardContent sx={{ p: 1 }}>
                                  <Typography variant="body2">{p.text}</Typography>
                                </CardContent>
                              </Card>
                            )}
                          </Draggable>
                        );
                      })}
                      {prov.placeholder}
                    </Box>
                  )}
                </Droppable>
              </AccordionDetails>
            </Accordion>
          ))}
        </DragDropContext>
      </Paper>
      <Box sx={{ height: 600 }}>
        <ReactFlowProvider>
          <ReactFlow nodes={nodes} edges={edges} onConnect={onConnect} nodeTypes={nodeTypes}>
            <MiniMap />
            <Controls />
          </ReactFlow>
        </ReactFlowProvider>
      </Box>
    </Box>
  );
}
