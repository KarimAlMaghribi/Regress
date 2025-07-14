import React, { useCallback, useEffect, useState, memo } from 'react';
import {
  Box,
  Paper,
  Typography,
  Card,
  CardContent,
  Button,
  Accordion,
  AccordionSummary,
  AccordionDetails
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ReactFlow, {
  MiniMap,
  Controls,
  addEdge,
  useNodesState,
  useEdgesState,
  Connection,
  Handle,
  Position,
  NodeProps,
  ReactFlowInstance,
  ReactFlowProvider
} from 'react-flow-renderer';
import { DragDropContext, Droppable, Draggable, DropResult } from 'react-beautiful-dnd';
import PageHeader from '../components/PageHeader';

interface Prompt { id: number; text: string; }
interface PromptGroup { id: number; name: string; promptIds: number[]; }

type NodeData = { label: string; type: 'pdf' | 'prompt' };

const CardNode = memo(({ data }: NodeProps<NodeData>) => (
  <Card variant="outlined" sx={{ minWidth: 120, textAlign: 'center' }}>
    <Handle type="target" position={Position.Top} />
    <CardContent sx={{ p: 1 }}>
      <Typography variant="body2">{data.label}</Typography>
    </CardContent>
    <Handle type="source" position={Position.Bottom} />
  </Card>
));

const nodeTypes = { card: CardNode };

export default function PipelineFlow() {
  const [pdfIds, setPdfIds] = useState<number[]>([]);
  const [selectedPdfs, setSelectedPdfs] = useState<number[]>([]);
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [groups, setGroups] = useState<PromptGroup[]>([]);
  const [selectedPrompts, setSelectedPrompts] = useState<number[]>([]);
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [flow, setFlow] = useState<ReactFlowInstance | null>(null);

  const onInit = useCallback((rf: ReactFlowInstance) => setFlow(rf), []);

  useEffect(() => { if (flow) flow.fitView(); }, [flow, nodes]);

  const onConnect = useCallback((c: Connection) => {
    setEdges(eds => addEdge({ ...c, animated: true, style: { stroke: '#6C5DD3' } }, eds));
  }, [setEdges]);

  useEffect(() => {
    fetch('http://localhost:8083/texts')
      .then(r => r.json())
      .then((list: { id: number }[]) => setPdfIds(list.map(i => i.id)))
      .catch(() => undefined);
  }, []);

  const togglePdf = (id: number) => {
    setSelectedPdfs(p => p.includes(id) ? p.filter(i => i !== id) : [...p, id]);
  };

  const addSelectedPdfs = () => {
    setNodes(ns => {
      const others = ns.filter(n => n.data.type !== 'pdf');
      const newNodes = selectedPdfs.map((id, i) => ({
        id: `pdf-${id}`,
        type: 'card',
        position: { x: 0, y: i * 140 },
        data: { label: `PDF ${id}`, type: 'pdf' } as NodeData
      }));
      return [...others, ...newNodes];
    });
  };

  const clearPdfs = () => {
    setSelectedPdfs([]);
    setNodes(ns => ns.filter(n => n.data.type !== 'pdf'));
  };

  const togglePrompt = (id: number) => {
    setSelectedPrompts(p => p.includes(id) ? p.filter(i => i !== id) : [...p, id]);
  };

  const selectAllGroup = (gid: number) => {
    const ids = groups.find(g => g.id === gid)?.promptIds || [];
    setSelectedPrompts(p => Array.from(new Set([...p, ...ids])));
  };

  const deselectAllGroup = (gid: number) => {
    const ids = groups.find(g => g.id === gid)?.promptIds || [];
    setSelectedPrompts(p => p.filter(i => !ids.includes(i)));
  };

  const onDragEnd = (result: DropResult) => {
    if (!result.destination) return;
    const gId = Number(result.source.droppableId);
    if (gId !== Number(result.destination.droppableId)) return;
    setGroups(gs => gs.map(g => {
      if (g.id === gId) {
        const list = Array.from(g.promptIds);
        const [removed] = list.splice(result.source.index, 1);
        list.splice(result.destination.index, 0, removed);
        return { ...g, promptIds: list };
      }
      return g;
    }));
  };

  useEffect(() => {
    setNodes(ns => {
      const others = ns.filter(n => n.data.type !== 'prompt');
      const selected = prompts.filter(p => selectedPrompts.includes(p.id));
      const newNodes = selected.map((p, i) => ({
        id: `prompt-${p.id}`,
        type: 'card',
        position: { x: 400, y: i * 140 },
        data: { label: p.text, type: 'prompt' } as NodeData
      }));
      return [...others, ...newNodes];
    });
  }, [selectedPrompts, prompts, setNodes]);

  useEffect(() => {
    fetch('http://localhost:8082/prompts')
      .then(r => r.json())
      .then(setPrompts)
      .catch(() => undefined);
    fetch('http://localhost:8082/prompt-groups')
      .then(r => r.json())
      .then(setGroups)
      .catch(() => undefined);
  }, []);

  return (
    <Box>
      <PageHeader title="Pipeline" breadcrumb={[{ label: 'Dashboard', to: '/' }, { label: 'Pipeline' }]} />
      <Paper sx={{ p:2, mb:2 }}>
        <Typography variant="h6" gutterBottom>PDF Stage</Typography>
        <Box sx={{ mb:2 }}>
          {pdfIds.map(id => {
            const selected = selectedPdfs.includes(id);
            return (
              <Card key={id} onClick={() => togglePdf(id)}
                    sx={{ mb:1, bgcolor: selected ? 'action.selected' : 'background.paper', cursor:'pointer' }}>
                <CardContent sx={{ p:1 }}>
                  <Typography variant="body2">PDF {id}</Typography>
                </CardContent>
              </Card>
            );
          })}
        </Box>
        <Button size="small" onClick={addSelectedPdfs} sx={{ mr:1 }}>Alle rein</Button>
        <Button size="small" onClick={clearPdfs}>Leeren</Button>
      </Paper>
      <Paper sx={{ p:2, mb:2 }}>
        <Typography variant="h6" gutterBottom>Prompt Stage</Typography>
        <DragDropContext onDragEnd={onDragEnd}>
          {groups.map(g => (
            <Accordion key={g.id} defaultExpanded>
              <AccordionSummary expandIcon={<ExpandMoreIcon />}> 
                <Typography>{g.name}</Typography>
                <Box sx={{ ml:'auto' }}>
                  <Button size="small" onClick={e => { e.stopPropagation(); selectAllGroup(g.id); }}>Alle auswählen</Button>
                  <Button size="small" onClick={e => { e.stopPropagation(); deselectAllGroup(g.id); }}>Alle abwählen</Button>
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
                              <Card ref={drag.innerRef} {...drag.draggableProps} {...drag.dragHandleProps}
                                    onClick={() => togglePrompt(pid)}
                                    sx={{ mb:1, bgcolor: selected ? 'action.selected' : 'background.paper', cursor:'pointer' }}>
                                <CardContent sx={{ p:1 }}>
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
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onInit={onInit}
            nodeTypes={nodeTypes}
          >
            <MiniMap />
            <Controls />
          </ReactFlow>
        </ReactFlowProvider>
      </Box>
    </Box>
  );
}
