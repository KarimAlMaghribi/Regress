import React, { useCallback, useEffect, useState } from 'react';
import {
  Box,
  Grid,
  Card,
  CardContent,
  Typography,
  Button,
  Accordion,
  AccordionSummary,
  AccordionDetails
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { useDropzone } from 'react-dropzone';
import {
  DragDropContext,
  Draggable,
  Droppable,
  DropResult
} from 'react-beautiful-dnd';
import ReactFlow, {
  Background,
  MiniMap,
  Controls,
  ReactFlowProvider,
  addEdge,
  Connection,
  Edge,
  Node,
  NodeProps,
  Position,
  Handle,
  useNodesState,
  useEdgesState,
  useReactFlow
} from 'react-flow-renderer';
import PageHeader from '../components/PageHeader';

interface PdfFile { id: string; name: string; }
interface Prompt { id: string; text: string; }
interface PromptGroup { id: string; title: string; prompts: Prompt[]; }

const FlowNode: React.FC<NodeProps> = ({ data }) => (
  <Card sx={{ minWidth: 120, textAlign: 'center' }}>
    <Handle type="target" position={Position.Top} />
    <CardContent>
      <Typography variant="body2">{data.label}</Typography>
    </CardContent>
    <Handle type="source" position={Position.Bottom} />
  </Card>
);

const nodeTypes = { card: FlowNode };

const initialGroups: PromptGroup[] = [
  {
    id: 'grp1',
    title: 'Beispielgruppe',
    prompts: [
      { id: 'p1', text: 'Prompt 1' },
      { id: 'p2', text: 'Prompt 2' }
    ]
  }
];

function FlowArea({ nodes, edges, onNodesChange, onEdgesChange, onConnect }: {
  nodes: Node[];
  edges: Edge[];
  onNodesChange: any;
  onEdgesChange: any;
  onConnect: (c: Connection) => void;
}) {
  const { fitView } = useReactFlow();
  useEffect(() => {
    fitView({ padding: 0.2 });
  }, [fitView]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      nodeTypes={nodeTypes}
      fitView
    >
      <MiniMap />
      <Controls />
      <Background color="#aaa" gap={16} />
    </ReactFlow>
  );
}

export default function PipelineFlow() {
  const [pdfs, setPdfs] = useState<PdfFile[]>([]);
  const [groups, setGroups] = useState<PromptGroup[]>(initialGroups);
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [pdfIndex, setPdfIndex] = useState(0);
  const [promptIndex, setPromptIndex] = useState(0);

  const addPdfNodes = useCallback((items: PdfFile[]) => {
    setNodes(n => {
      const existing = new Set(n.map(nd => nd.id));
      const newNodes = items
        .filter(p => !existing.has(`pdf-${p.id}`))
        .map((p, i) => ({
          id: `pdf-${p.id}`,
          type: 'card',
          position: { x: 0, y: (pdfIndex + i) * 80 },
          data: { label: p.name }
        }));
      setPdfIndex(idx => idx + newNodes.length);
      return [...n, ...newNodes];
    });
  }, [setNodes, pdfIndex]);

  const addPromptNodes = useCallback((items: Prompt[]) => {
    setNodes(n => {
      const existing = new Set(n.map(nd => nd.id));
      const newNodes = items
        .filter(p => !existing.has(`prompt-${p.id}`))
        .map((p, i) => ({
          id: `prompt-${p.id}`,
          type: 'card',
          position: { x: 300, y: (promptIndex + i) * 80 },
          data: { label: p.text }
        }));
      setPromptIndex(idx => idx + newNodes.length);
      return [...n, ...newNodes];
    });
  }, [setNodes, promptIndex]);

  const handleFiles = useCallback((files: File[]) => {
    const newPdfs = files.map(f => ({ id: `${Date.now()}-${f.name}`, name: f.name }));
    setPdfs(p => [...p, ...newPdfs]);
    addPdfNodes(newPdfs);
  }, [addPdfNodes]);

  const onDrop = useCallback((accepted: File[]) => handleFiles(accepted), [handleFiles]);
  const { getRootProps, getInputProps, isDragActive } = useDropzone({ onDrop, multiple: true });

  const selectAllPdfs = () => addPdfNodes(pdfs);
  const clearPdfs = () => setNodes(n => n.filter(nd => !nd.id.startsWith('pdf-')));

  const selectPrompts = (gid: string) => {
    const grp = groups.find(g => g.id === gid);
    if (grp) addPromptNodes(grp.prompts);
  };
  const clearPrompts = (gid: string) => {
    const ids = new Set(groups.find(g => g.id === gid)?.prompts.map(p => `prompt-${p.id}`));
    setNodes(n => n.filter(nd => !ids.has(nd.id)));
  };

  const onConnect = useCallback((c: Connection) => {
    setEdges(eds => addEdge({ ...c, animated: true, style: { stroke: '#1976d2' } }, eds));
  }, [setEdges]);

  const onDragEnd = (res: DropResult) => {
    if (!res.destination) return;
    setGroups(gs => {
      const src = gs.find(g => g.id === res.source.droppableId);
      const dest = gs.find(g => g.id === res.destination!.droppableId);
      if (!src || !dest) return gs;
      const [moved] = src.prompts.splice(res.source.index, 1);
      dest.prompts.splice(res.destination.index, 0, moved);
      return [...gs];
    });
  };

  return (
    <Box>
      <PageHeader title="Pipeline" breadcrumb={[{ label: 'Dashboard', to: '/' }, { label: 'Pipeline' }]} />
      <Grid container spacing={2} sx={{ mb: 2 }}>
        <Grid item xs={12} md>
          <Box
            {...getRootProps()}
            sx={{ border: '2px dashed #aaa', p: 2, textAlign: 'center', cursor: 'pointer' }}
          >
            <input {...getInputProps()} />
            {isDragActive ? 'Dateien hier ablegen' : 'PDFs hierher ziehen oder klicken'}
          </Box>
        </Grid>
        <Grid item>
          <Button onClick={selectAllPdfs} variant="outlined">Alle rein</Button>
        </Grid>
        <Grid item>
          <Button onClick={clearPdfs} variant="outlined">Leeren</Button>
        </Grid>
      </Grid>

      <DragDropContext onDragEnd={onDragEnd}>
        {groups.map(group => (
          <Accordion key={group.id} defaultExpanded>
            <AccordionSummary expandIcon={<ExpandMoreIcon />}>
              <Typography sx={{ flexGrow: 1 }}>{group.title}</Typography>
              <Button size="small" onClick={e => { e.stopPropagation(); selectPrompts(group.id); }}>Alle auswählen</Button>
              <Button size="small" onClick={e => { e.stopPropagation(); clearPrompts(group.id); }}>Alle abwählen</Button>
            </AccordionSummary>
            <AccordionDetails>
              <Droppable droppableId={group.id} direction="vertical">
                {provided => (
                  <Box ref={provided.innerRef} {...provided.droppableProps}>
                    {group.prompts.map((p, idx) => (
                      <Draggable draggableId={p.id} index={idx} key={p.id}>
                        {prov => (
                          <Card ref={prov.innerRef} {...prov.draggableProps} {...prov.dragHandleProps} sx={{ mb: 1 }}>
                            <CardContent>
                              <Typography variant="body2">{p.text}</Typography>
                            </CardContent>
                          </Card>
                        )}
                      </Draggable>
                    ))}
                    {provided.placeholder}
                  </Box>
                )}
              </Droppable>
            </AccordionDetails>
          </Accordion>
        ))}
      </DragDropContext>

      <Box sx={{ height: 600, mt: 2 }}>
        <ReactFlowProvider>
          <FlowArea
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
          />
        </ReactFlowProvider>
      </Box>
    </Box>
  );
}
