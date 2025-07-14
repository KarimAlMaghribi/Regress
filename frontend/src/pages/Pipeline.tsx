import React, { useState, useMemo, useCallback, useRef } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import Selecto from 'react-selecto';
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
  Grid,
  Pagination,
  Modal,
  IconButton,
  Skeleton,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import PictureAsPdfIcon from '@mui/icons-material/PictureAsPdf';
import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubbleOutline';
import CloseIcon from '@mui/icons-material/Close';
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

pdfjs.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjs.version}/pdf.worker.min.js`;

const ingest = import.meta.env.VITE_INGEST_URL || 'http://localhost:8081';

interface Step { id: string; label: string; type: 'pdf' | 'prompt'; }
interface Stage { id: string; name: string; steps: Step[]; }
interface Prompt { id: number; text: string; }
interface PromptGroup { id: number; name: string; promptIds: number[]; }

type NodeData = { label: string; type: 'pdf' | 'prompt'; onOpen?: () => void };

const CardNode = ({ data, id }: NodeProps<NodeData>) => {
  const handleClick = () => {
    if (data.type === 'pdf') {
      data.onOpen ? data.onOpen() : window.open(`${ingest}/pdf/${id.replace('pdf-', '')}.pdf`);
    }
  };

  return (
    <Card variant="outlined" sx={{ minWidth: 170, textAlign: 'center', cursor: 'pointer' }} onClick={handleClick}>
      <Handle type="target" position={Position.Top} />
      <CardContent sx={{ p: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 1, pointerEvents: 'none' }}>
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
};

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
  const [pdfPage, setPdfPage] = useState(1);
  const [promptPages, setPromptPages] = useState<Record<number, number>>({});
  const [previewId, setPreviewId] = useState<number | null>(null);
  const pdfGridRef = useRef<HTMLDivElement | null>(null);
  const [pipeline, setPipeline] = useState<Stage[]>([
    { id: 'pdf', name: 'PDF Stage', steps: [] },
    { id: 'prompt', name: 'Prompt Stage', steps: [] },
  ]);
  const pdfPerPage = 8;
  const promptsPerPage = 8;

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

  const selectPdfIds = (ids: number[]) => {
    setPipeline(p => {
      const idx = p.findIndex(s => s.id === 'pdf');
      if (idx === -1) return p;
      const stage = p[idx];
      const steps = [...stage.steps];
      ids.forEach(id => {
        if (!steps.some(s => s.id === `pdf-${id}`)) {
          steps.push({ id: `pdf-${id}`, label: `PDF ${id}`, type: 'pdf' });
        }
      });
      const np = [...p];
      np[idx] = { ...stage, steps };
      return np;
    });
  };

  const pagedPdfIds = useMemo(
    () => pdfIds.slice((pdfPage - 1) * pdfPerPage, pdfPage * pdfPerPage),
    [pdfIds, pdfPage],
  );

  const pagedPrompts = (g: PromptGroup) => {
    const page = promptPages[g.id] || 1;
    const ids = g.promptIds.slice((page - 1) * promptsPerPage, page * promptsPerPage);
    return { page, ids, total: Math.ceil(g.promptIds.length / promptsPerPage) };
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
        const idNum = step.type === 'pdf' ? Number(step.id.replace('pdf-', '')) : undefined;
        ns.push({
          id: step.id,
          type: 'card',
          data: {
            label: step.label,
            type: step.type,
            onOpen: step.type === 'pdf' && idNum !== undefined ? () => setPreviewId(idNum) : undefined,
          },
          position: { x: 0, y: 0 },
        });
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

  const onNodeClick = useCallback((_: any, node: Node<NodeData>) => {
    if (node.data.type === 'pdf') {
      const id = Number(node.id.replace('pdf-', ''));
      setPreviewId(id);
    }
  }, []);

  const pdfStage = pipeline.find(s => s.id === 'pdf');
  const promptStage = pipeline.find(s => s.id === 'prompt');

  const selectedPdfs = pdfStage?.steps.map(s => Number(s.id.replace('pdf-', ''))) || [];
  const selectedPrompts = promptStage?.steps.map(s => Number(s.id.replace('prompt-', ''))) || [];

  const activate = () => {
    console.log('activate pipeline');
  };

  return (
    <Box>
      <PageHeader
        title="Pipeline"
        breadcrumb={[{ label: 'Dashboard', to: '/' }, { label: 'Pipeline' }]}
        actions={<Button variant="contained" onClick={activate}>Pipeline aktivieren</Button>}
      />
      <Paper sx={{ p: 2, mb: 2 }}>
        <Typography variant="h6" gutterBottom>
          PDF Stage
        </Typography>
        <Box sx={{ mb: 2 }} className="pdf-grid" ref={pdfGridRef}>
          <Grid container spacing={1}>
            {pagedPdfIds.map(id => {
              const selected = selectedPdfs.includes(id);
              return (
                <Grid item xs={6} sm={4} md={3} lg={2} key={id}>
                  <Card
                    className="pdf-item"
                    data-id={id}
                    onClick={() => togglePdf(id)}
                    sx={{ bgcolor: selected ? 'action.selected' : 'background.paper', cursor: 'pointer', userSelect: 'none' }}
                  >
                    <CardContent sx={{ p: 1 }}>
                      <Typography variant="body2">PDF {id}</Typography>
                    </CardContent>
                  </Card>
                </Grid>
              );
            })}
          </Grid>
          <Selecto
            container={() => pdfGridRef.current!}
            selectableTargets={[ '.pdf-item' ]}
            onSelectEnd={e => {
              const ids = e.selected.map(el => Number(el.getAttribute('data-id')));
              if (ids.length) selectPdfIds(ids);
            }}
          />
        </Box>
        <Pagination
          count={Math.ceil(pdfIds.length / pdfPerPage)}
          page={pdfPage}
          onChange={(_, p) => setPdfPage(p)}
          size="small"
          sx={{ mb: 1 }}
        />
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
                  {prov => {
                    const { page, ids, total } = pagedPrompts(g);
                    return (
                    <Box ref={prov.innerRef} {...prov.droppableProps}>
                      <Grid container spacing={1}>
                      {ids.map((pid, idx) => {
                        const p = prompts.find(pr => pr.id === pid);
                        if (!p) return null;
                        const selected = selectedPrompts.includes(pid);
                        return (
                          <Draggable key={pid} draggableId={String(pid)} index={idx}>
                            {drag => (
                              <Grid item xs={6} sm={4} md={3} lg={2} ref={drag.innerRef} {...drag.draggableProps} {...drag.dragHandleProps}>
                                <Card
                                  onClick={() => togglePrompt(pid)}
                                  sx={{ bgcolor: selected ? 'action.selected' : 'background.paper', cursor: 'pointer', userSelect: 'none' }}
                                >
                                  <CardContent sx={{ p: 1 }}>
                                    <Typography variant="body2">{p.text}</Typography>
                                  </CardContent>
                                </Card>
                              </Grid>
                            )}
                          </Draggable>
                        );
                      })}
                      </Grid>
                      <Pagination
                        count={total}
                        page={page}
                        onChange={(_,p)=> setPromptPages(ps=>({ ...ps, [g.id]: p }))}
                        size="small"
                        sx={{ mt:1 }}
                      />
                      {prov.placeholder}
                    </Box>
                    );
                  }}
                </Droppable>
              </AccordionDetails>
            </Accordion>
          ))}
        </DragDropContext>
      </Paper>
      <Box sx={{ height: 600 }}>
        <ReactFlowProvider>
          <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodeClick={onNodeClick}>
            <MiniMap />
            <Controls />
          </ReactFlow>
        </ReactFlowProvider>
      </Box>
      <Modal open={previewId !== null} onClose={() => setPreviewId(null)}>
        <Box sx={{ position:'absolute', top:'50%', left:'50%', transform:'translate(-50%, -50%)', bgcolor:'background.paper', p:2 }}>
          <IconButton onClick={() => setPreviewId(null)} sx={{ position:'absolute', top:8, right:8 }}>
            <CloseIcon />
          </IconButton>
          {previewId !== null && (
            <Document
              file={`${ingest}/pdf/${previewId}.pdf`}
              loading={<Skeleton variant="rectangular" height={400} />}
              onLoadError={console.error}
            >
              <Page pageNumber={1} width={600} />
            </Document>
          )}
        </Box>
      </Modal>
    </Box>
  );
}
