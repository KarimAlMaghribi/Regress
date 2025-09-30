import { useState, useEffect, useMemo, useRef } from 'react';
import {
  Box, Table, TableHead, TableRow, TableCell, TableBody, IconButton,
  Button, Drawer, TextField, Select, MenuItem, Checkbox, Snackbar, Alert, Typography, Chip
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import AddIcon from '@mui/icons-material/Add';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import { usePipelineStore, PipelineStep } from '../hooks/usePipelineStore';
import { useLinearIndentLayout, LayoutRow } from '../hooks/useLinearIndentLayout';
import StepDialog from './PipelineEditor/StepDialog';
import { useNavigate } from 'react-router-dom';
import uuid from '../utils/uuid';

interface PromptOption { id: number; text: string; }
const API = import.meta.env.VITE_API_URL || 'http://localhost:8084';
const PROMPT_API = import.meta.env.VITE_PROMPT_URL || 'http://localhost:8082';
const ROOT = 'Root';

/* ──────────────────────────────────────────────────────────────────────────────
   Scoring-Konfiguration (nur EIN Wert: min_signal)
   - UI: "Mindest-Signal (0..1)"
   - UNSURE wird serverseitig ignoriert
   - Backcompat: falls alte Pipelines min_weight_yes/no haben, initialisieren wir min_signal = max(yes, no)
──────────────────────────────────────────────────────────────────────────────── */
function ScoringConfigFields({
                               value,
                               onChange,
                             }: {
  value?: any;
  onChange: (cfg: any) => void;
}) {
  // Backcompat-Initialisierung
  const initialMinSignal =
      typeof value?.min_signal === 'number'
          ? value.min_signal
          : Math.max(
              typeof value?.min_weight_yes === 'number' ? value.min_weight_yes : 0,
              typeof value?.min_weight_no === 'number' ? value.min_weight_no : 0
          );

  // Tipp-freundlicher lokaler State
  const [localMinSignal, setLocalMinSignal] = useState<number | ''>(
      Number.isFinite(initialMinSignal) ? Number(initialMinSignal.toFixed(3)) : 0
  );

  // Parent -> Local Sync
  useEffect(() => {
    const ext = Number.isFinite(initialMinSignal) ? Number(initialMinSignal) : 0;
    setLocalMinSignal(Number(ext.toFixed(3)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value?.min_signal, value?.min_weight_yes, value?.min_weight_no]);

  const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

  const commit = (next: number) => {
    const nextCfg = {
      ...(value || {}),
      min_signal: next,
    };
    onChange(nextCfg); // ← sofort in den Store
  };

  const handleChange = (raw: string) => {
    if (raw === '') {
      setLocalMinSignal('');
      return;
    }
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) return;
    const clamped = clamp01(parsed);
    setLocalMinSignal(clamped);
    commit(clamped);
  };

  return (
      <Box sx={{ display: 'grid', gridTemplateColumns: '1fr', gap: 1 }}>
        <Typography variant="subtitle2" sx={{ mt: 1 }}>
          Scoring · Mindest-Signal
        </Typography>

        <TextField
            label="Mindest-Signal (0..1)"
            type="number"
            value={localMinSignal}
            onChange={(e) => handleChange(e.target.value)}
            inputProps={{ step: 0.1, min: 0, max: 1 }}
            onBlur={() => {
              if (localMinSignal === '') {
                setLocalMinSignal(0);
                commit(0);
              }
            }}
            helperText="Einzel-Stimmen zählen nur, wenn ihr Signal ≥ Mindest-Signal ist. UNSURE wird generell ignoriert."
        />
      </Box>
  );
}

export default function PipelineEditor() {
  const {
    name, steps, updateName,
    addStepAt, updateStep, reorder, removeStep,
    currentPipelineId, dirty, confirmIfDirty
  } = usePipelineStore();
  const navigate = useNavigate();
  const routeColors = useRef<Record<string,string>>({});
  const getRouteColor = (routeKey: string) => {
    if (!routeColors.current[routeKey]) {
      routeColors.current[routeKey] =
          '#' + Math.floor(Math.random() * 0xFFFFFF).toString(16).padStart(6, '0');
    }
    return routeColors.current[routeKey];
  };

  const [edit, setEdit] = useState<PipelineStep | null>(null);
  const [draft, setDraft] = useState<PipelineStep | null>(null);
  const [insertPos, setInsertPos] = useState<number>(steps.length);
  const [promptOptions, setPromptOptions] = useState<Record<string, PromptOption[]>>({});
  const [error, setError] = useState('');
  const totalCols = 9;

  // Name-Update leicht entkoppeln
  const debouncedUpdateName = useMemo(() => {
    let t: any;
    return (v: string) => {
      clearTimeout(t);
      t = setTimeout(() => updateName(v), 200);
    };
  }, [updateName]);

  // Beim Steps-Update edit-Step frisch ziehen (damit UI die neuesten Werte zeigt)
  useEffect(() => {
    if (!edit) return;
    const latest = steps.find(s => s.id === edit.id);
    if (latest && latest !== edit) setEdit(latest);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [steps]);

  /* memo-ise linear rows with depth */
  const layoutRows = useMemo<LayoutRow[]>(() => useLinearIndentLayout(steps), [steps]);

  const routeKeysUpTo = (idx: number): string[] => {
    const set = new Set<string>([ROOT]);
    for (let i = 0; i < idx; i++) {
      const d = steps[i];
      if (d.type === 'DecisionPrompt') {
        if (d.yesKey) set.add(d.yesKey);
        if (d.noKey) set.add(d.noKey);
      }
    }
    return Array.from(set);
  };

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const fetchPrompts = (t: string) => {
    if (promptOptions[t]) return;
    fetch(`${PROMPT_API}/prompts?type=${t}`)
    .then(r => r.ok ? r.json() : [])
    .then((list: PromptOption[]) => setPromptOptions(o => ({ ...o, [t]: list })))
    .catch(() => setPromptOptions(o => ({ ...o, [t]: [] })));
  };

  const saveNewStep = () => {
    if (!draft) return;
    const route = draft.route;
    let idx = -1;
    steps.forEach((s, i) => { if (s.route === route) idx = i + 1; });
    if (idx === -1) idx = steps.length;
    addStepAt(idx, draft as any)
    .then(() => setDraft(null))
    .catch(e => setError(String(e)));
  };

  const moveStep = async (from: number, to: number) => {
    if (to < 0 || to >= steps.length) return;
    const newOrder = [...steps.map(s => s.id)];
    const [id] = newOrder.splice(from, 1);
    newOrder.splice(to, 0, id);
    try {
      await reorder(newOrder);
    } catch (e) {
      setError(String(e));
    }
  };

  const handleRouteChange = async (stepId: string, newRoute: string) => {
    try {
      const routeValue = newRoute === ROOT ? undefined : newRoute;
      await updateStep(stepId, { route: routeValue });
      const others = usePipelineStore.getState().steps.filter(s => s.id !== stepId);
      let idx = -1;
      others.forEach((s, i) => { if (s.route === routeValue) idx = i + 1; });
      if (idx === -1) idx = others.length;
      const order = others.map(s => s.id);
      order.splice(idx, 0, stepId);
      await reorder(order);
    } catch (err) {
      setError(String(err));
    }
  };

  useEffect(() => {
    if (draft?.type) fetchPrompts(draft.type);
  }, [draft?.type]);

  useEffect(() => {
    if (edit?.type) fetchPrompts(edit.type);
  }, [edit?.type]);

  if (!currentPipelineId) {
    return <Typography>Select or create a pipeline</Typography>;
  }

  return (
      <Box>
        <Box sx={{ mb:2, display:'flex', gap:1, alignItems:'center' }}>
          <Button onClick={() => { if (confirmIfDirty()) navigate('/pipeline'); }}>Zur Liste</Button>
          <TextField
              size="small"
              label="Name"
              value={name}
              onChange={e=>debouncedUpdateName(e.target.value)}
          />
          <Button
              startIcon={<AddIcon/>}
              onClick={() => {
                setInsertPos(steps.length);
                setDraft({ id: uuid(), type:'ExtractionPrompt', promptId:0, active:true } as any);
              }}
          >
            Step
          </Button>
        </Box>

        <Table className="table">
          <TableHead>
            <TableRow>
              <TableCell>#</TableCell>
              <TableCell></TableCell>
              <TableCell>Type</TableCell>
              <TableCell>Prompt</TableCell>
              <TableCell>Yes-Key</TableCell>
              <TableCell>No-Key</TableCell>
              <TableCell>Route</TableCell>
              <TableCell>Active</TableCell>
              <TableCell></TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {layoutRows.map(r => {
              const idx = steps.findIndex(s => s.id === r.step.id);
              return (
                  <>
                    <TableRow key={r.step.id}>
                      <TableCell sx={{ pl: r.depth * 4 }}>{r.rowLabel}</TableCell>
                      <TableCell>
                        <IconButton size="small" onClick={() => moveStep(idx, idx - 1)}>
                          <ArrowUpwardIcon fontSize="small" />
                        </IconButton>
                        <IconButton size="small" onClick={() => moveStep(idx, idx + 1)}>
                          <ArrowDownwardIcon fontSize="small" />
                        </IconButton>
                        <IconButton size="small" onClick={() => {
                          setInsertPos(idx + 1);
                          setDraft({ ...(r.step as any), id: uuid() });
                        }}>
                          <AddIcon fontSize="small" />
                        </IconButton>
                      </TableCell>
                      <TableCell>{r.step.type}</TableCell>
                      <TableCell>{r.step.promptId}</TableCell>
                      <TableCell>{r.step.type==='DecisionPrompt' ? r.step.yesKey : '—'}</TableCell>
                      <TableCell>{r.step.type==='DecisionPrompt' ? r.step.noKey : '—'}</TableCell>
                      <TableCell>
                        <Select
                            value={r.step.route||ROOT}
                            onChange={e => handleRouteChange(r.step.id, e.target.value as string)}
                        >
                          {routeKeysUpTo(idx).map(k => (<MenuItem key={k} value={k}>{k}</MenuItem>))}
                        </Select>
                      </TableCell>
                      <TableCell>
                        <Checkbox
                            checked={r.step.active !== false}
                            onChange={e => usePipelineStore.getState().updateStep(r.step.id, { active: e.target.checked }).catch(err => setError(String(err)))}
                        />
                      </TableCell>
                      <TableCell>
                        {r.warnings.map((w, i) => (
                            <Chip key={i} label={w} size="small" color="warning" sx={{ mr: 0.5 }} />
                        ))}
                        <IconButton onClick={() => removeStep(r.step.id).catch(err => setError(String(err)))}>
                          <DeleteIcon />
                        </IconButton>
                        <Button size="small" onClick={() => setEdit(r.step)}>Edit</Button>
                      </TableCell>
                    </TableRow>

                    {r.step.type === 'DecisionPrompt' && (
                        <TableRow>
                          <TableCell colSpan={totalCols} sx={{ p: 0 }}>
                            <Box
                                width="100%"
                                height="4px"
                                sx={{ backgroundColor: getRouteColor(r.step.route || r.step.yesKey || '') }}
                            />
                          </TableCell>
                        </TableRow>
                    )}
                  </>
              );
            })}
          </TableBody>
        </Table>

        {/* EDIT Drawer */}
        <Drawer open={!!edit} onClose={() => setEdit(null)} anchor="right">
          {edit && (
              <Box sx={{ p:2, width: 360, display:'flex', flexDirection:'column', gap:2 }}>
                <Select
                    fullWidth
                    value={edit.type}
                    onChange={e=>{
                      const val=e.target.value as string;
                      updateStep(edit.id,{type:val}).catch(er=>setError(String(er)));
                    }}
                >
                  <MenuItem value="ExtractionPrompt">ExtractionPrompt</MenuItem>
                  <MenuItem value="ScoringPrompt">ScoringPrompt</MenuItem>
                  <MenuItem value="DecisionPrompt">DecisionPrompt</MenuItem>
                </Select>

                <Select
                    fullWidth
                    value={edit.promptId}
                    onChange={e=>updateStep(edit.id,{promptId:Number(e.target.value)}).catch(er=>setError(String(er)))}
                >
                  {(promptOptions[edit.type]||[]).map(p=>(
                      <MenuItem key={p.id} value={p.id}>{p.text}</MenuItem>
                  ))}
                </Select>

                {edit.type==='DecisionPrompt' && (
                    <StepDialog step={edit} />
                )}

                {/* Scoring-Konfig (nur Mindest-Signal) */}
                {edit.type==='ScoringPrompt' && (
                    <ScoringConfigFields
                        value={(edit as any).config}
                        onChange={(cfg)=> updateStep(edit.id, { config: cfg } as any).catch(er => setError(String(er)))}
                    />
                )}

                <Select
                    fullWidth
                    value={edit.route||ROOT}
                    onChange={e => handleRouteChange(edit.id, e.target.value as string)}
                >
                  {routeKeysUpTo(steps.findIndex(s=>s.id===edit.id)).map(k => (
                      <MenuItem key={k} value={k}>{k}</MenuItem>
                  ))}
                </Select>
              </Box>
          )}
        </Drawer>

        {/* DRAFT Drawer */}
        <Drawer open={!!draft} onClose={() => setDraft(null)} anchor="right">
          {draft && (
              <Box sx={{ p:2, width:360, display:'flex', flexDirection:'column', gap:2 }}>
                <Select
                    fullWidth
                    value={draft.type}
                    onChange={e=>{
                      const val=e.target.value as string;
                      setDraft({ ...(draft as any), type:val });
                      fetchPrompts(val);
                    }}
                >
                  <MenuItem value="ExtractionPrompt">ExtractionPrompt</MenuItem>
                  <MenuItem value="ScoringPrompt">ScoringPrompt</MenuItem>
                  <MenuItem value="DecisionPrompt">DecisionPrompt</MenuItem>
                </Select>

                <Select
                    fullWidth
                    value={draft.promptId}
                    onChange={e=>setDraft({ ...(draft as any), promptId:Number(e.target.value) })}
                >
                  {(promptOptions[draft.type]||[]).map(p=>(
                      <MenuItem key={p.id} value={p.id}>{p.text}</MenuItem>
                  ))}
                </Select>

                {draft.type==='DecisionPrompt' && (
                    <StepDialog step={draft} onSave={changes => setDraft({ ...(draft as any), ...changes })} />
                )}

                {/* Scoring-Konfig (nur Mindest-Signal) */}
                {draft.type==='ScoringPrompt' && (
                    <ScoringConfigFields
                        value={(draft as any).config}
                        onChange={(cfg) => setDraft({ ...(draft as any), config: cfg } as any)}
                    />
                )}

                <Select
                    fullWidth
                    value={draft.route||ROOT}
                    onChange={e=>setDraft({ ...(draft as any), route: e.target.value===ROOT?undefined:e.target.value })}
                >
                  {routeKeysUpTo(insertPos).map(k => (
                      <MenuItem key={k} value={k}>{k}</MenuItem>
                  ))}
                </Select>

                <Box sx={{ display:'flex', justifyContent:'flex-end', mt:2, gap:1 }}>
                  <Button variant="outlined" onClick={() => setDraft(null)}>Cancel</Button>
                  <Button
                      variant="contained"
                      onClick={saveNewStep}
                      disabled={draft.type==='DecisionPrompt' && !(draft.yesKey && draft.noKey)}
                  >
                    Add
                  </Button>
                </Box>
              </Box>
          )}
        </Drawer>

        <Snackbar open={!!error} autoHideDuration={6000} onClose={()=>setError('')}>
          <Alert severity="error" onClose={()=>setError('')}>{error}</Alert>
        </Snackbar>
      </Box>
  );
}
