import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  Box, Table, TableHead, TableRow, TableCell, TableBody, IconButton,
  Button, Drawer, TextField, Select, MenuItem, Checkbox, Snackbar, Alert, Typography, Chip,
  Paper, TableContainer, Stack, Tooltip
} from '@mui/material';
import { alpha } from '@mui/material/styles';
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

const typePalette: Record<string, { emoji: string; color: string; title: string; description: string }> = {
  ExtractionPrompt: {
    emoji: '🪄',
    color: '#5A6CF0',
    title: 'ExtractionPrompt',
    description: 'Extrahiert gezielte Informationen aus Inhalten.',
  },
  ScoringPrompt: {
    emoji: '🌟',
    color: '#F2A052',
    title: 'ScoringPrompt',
    description: 'Bewertet Antworten und vergibt Scores.',
  },
  DecisionPrompt: {
    emoji: '🔀',
    color: '#4BA8A5',
    title: 'DecisionPrompt',
    description: 'Verzweigt basierend auf Entscheidungen.',
  },
};

const fallbackTypeStyle = {
  emoji: '🧩',
  color: '#94A3B8',
  title: 'Unbekannter Prompt',
  description: 'Allgemeiner Pipelineschritt.',
};

/* ===== Helper: Store-Persist-Funktion (fallback-sicher) ===== */
async function tryPersistPipeline() {
  try {
    const st: any = (usePipelineStore as any)?.getState?.();
    const fn =
        st?.savePipeline ||
        st?.save ||
        st?.persist ||
        st?.flush ||
        st?.saveCurrent ||
        null;
    if (typeof fn === 'function') {
      await fn();
    }
  } catch {
    /* ignore – falls der Store keine Save-Funktion hat */
  }
}

/* ────────────────────────────────────────────────────────────────
   Scoring-Konfiguration (nur EIN Wert: min_signal)
   - UI: "Mindest-Signal (0..1)"
   - UNSURE wird serverseitig ignoriert
   - Backcompat: falls alte Pipelines min_weight_yes/no haben, initialisieren wir min_signal = max(yes, no)
────────────────────────────────────────────────────────────────── */
function ScoringConfigFields({
                               value,
                               onChange,
                               onPersist,
                             }: {
  value?: any;
  onChange: (cfg: any) => Promise<void> | void;
  onPersist?: () => Promise<void> | void;
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

  const commit = async (next: number) => {
    const nextCfg = {
      ...(value || {}),
      min_signal: next,
    };
    await onChange(nextCfg);      // sofort im Store
    await (onPersist?.() ?? tryPersistPipeline()); // direkt persistieren (falls vorhanden)
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
    void commit(clamped);
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
                void commit(0);
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
      const random = Math.floor(Math.random() * 0xffffff);
      const pastel = (random & 0xfefefe) >> 1; // soften random color
      routeColors.current[routeKey] = `#${pastel.toString(16).padStart(6, '0')}`;
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

  const fetchPrompts = useCallback((t: string) => {
    if (!t || promptOptions[t]) return;
    fetch(`${PROMPT_API}/prompts?type=${t}`)
    .then(r => (r.ok ? r.json() : []))
    .then((list: PromptOption[]) => setPromptOptions(o => ({ ...o, [t]: list })))
    .catch(() => setPromptOptions(o => ({ ...o, [t]: [] })));
  }, [promptOptions]);

  useEffect(() => {
    const uniqueTypes = Array.from(
        new Set(
            steps
            .map(s => s.type)
            .filter((t): t is string => Boolean(t))
        )
    );
    uniqueTypes.forEach(t => fetchPrompts(t));
  }, [steps, fetchPrompts]);

  const saveNewStep = () => {
    if (!draft) return;
    const route = draft.route;
    let idx = -1;
    steps.forEach((s, i) => { if (s.route === route) idx = i + 1; });
    if (idx === -1) idx = steps.length;
    addStepAt(idx, draft as any)
    .then(() => tryPersistPipeline())
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
      await tryPersistPipeline();
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
      await tryPersistPipeline();
    } catch (err) {
      setError(String(err));
    }
  };

  useEffect(() => {
    if (draft?.type) fetchPrompts(draft.type);
  }, [draft?.type, fetchPrompts]);

  useEffect(() => {
    if (edit?.type) fetchPrompts(edit.type);
  }, [edit?.type, fetchPrompts]);

  if (!currentPipelineId) {
    return <Typography>Select or create a pipeline</Typography>;
  }

  const closeEdit = async () => {
    await tryPersistPipeline();
    setEdit(null);
  };

  const closeDraft = async () => {
    await tryPersistPipeline();
    setDraft(null);
  };

  const getTypeStyle = (type?: string) => (type ? typePalette[type] : undefined) || fallbackTypeStyle;

  const resolvePromptText = (step: PipelineStep) => {
    const list = promptOptions[step.type] || [];
    return list.find(p => p.id === step.promptId)?.text;
  };

  return (
      <Box sx={{ display:'flex', flexDirection:'column', gap:3 }}>
        <Box
            sx={{
              mb: 1,
              p: 3,
              borderRadius: 4,
              backgroundColor: '#f8fafc',
              border: '1px solid #e2e8f0',
              color: '#0f172a',
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 2,
            }}
        >
          <Box>
            <Typography variant="h4" sx={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: 1, color: '#0f172a' }}>
              🧪 Pipeline Atelier
            </Typography>
            <Typography variant="subtitle1" sx={{ color: '#475569' }}>
              {name
                  ? `„${name}“ – Feinschliff für deine perfekte Analyse-Pipeline.`
                  : 'Verleihe deiner neuen Pipeline einen klaren Namen.'}
            </Typography>
          </Box>
          <Chip
              label={dirty ? '⚠️ Ungespeicherte Änderungen' : '✅ Alles gespeichert'}
              variant="outlined"
              sx={{
                fontWeight: 600,
                fontSize: '0.9rem',
                px: 1.5,
                py: 1,
                borderColor: dirty ? '#f59e0b' : '#22c55e',
                color: dirty ? '#b45309' : '#15803d',
                backgroundColor: dirty ? 'rgba(245, 158, 11, 0.08)' : 'rgba(34, 197, 94, 0.08)',
              }}
          />
        </Box>

        <Paper
            sx={{
              p: 2,
              borderRadius: 4,
              border: '1px solid #e2e8f0',
              boxShadow: '0 10px 30px rgba(15, 23, 42, 0.04)',
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
              backgroundColor: '#ffffff',
            }}
        >
          <Stack direction={{ xs: 'column', lg: 'row' }} spacing={2} alignItems={{ lg: 'center' }}>
            <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ flexGrow: 1 }}>
              <Button
                  variant="outlined"
                  color="secondary"
                  onClick={() => { if (confirmIfDirty()) navigate('/pipeline'); }}
                  sx={{ fontWeight: 600, borderRadius: 3 }}
              >
                ⬅️ Zur Pipeline-Übersicht
              </Button>
              <TextField
                  size="small"
                  label="Pipelinename"
                  value={name}
                  onChange={e => debouncedUpdateName(e.target.value)}
                  fullWidth
                  InputProps={{ sx: { fontWeight: 600 } }}
              />
            </Stack>
            <Button
                variant="contained"
                color="primary"
                startIcon={<AddIcon />}
                onClick={() => {
                  setInsertPos(steps.length);
                  setDraft({ id: uuid(), type: 'ExtractionPrompt', promptId: 0, active: true } as any);
                }}
                sx={{ fontWeight: 700, borderRadius: 3, boxShadow: 'none', textTransform: 'none' }}
            >
              ✨ Schritt hinzufügen
            </Button>
          </Stack>
        </Paper>

        <TableContainer component={Paper} sx={{ borderRadius: 4, boxShadow: '0 12px 24px rgba(15, 23, 42, 0.05)', border: '1px solid #e2e8f0' }}>
          <Table className="table" size="small">
            <TableHead>
            <TableRow sx={{ backgroundColor: alpha('#0f172a', 0.05) }}>
              <TableCell sx={{ fontWeight: 700 }}>🔢 Nr.</TableCell>
              <TableCell sx={{ fontWeight: 700 }}>⚙️ Aktionen</TableCell>
              <TableCell sx={{ fontWeight: 700 }}>🎭 Prompt-Typ</TableCell>
              <TableCell sx={{ fontWeight: 700 }}>📝 Vollständiger Prompt-Name</TableCell>
              <TableCell sx={{ fontWeight: 700 }}>✅ Yes-Key</TableCell>
              <TableCell sx={{ fontWeight: 700 }}>🚫 No-Key</TableCell>
              <TableCell sx={{ fontWeight: 700 }}>🛣️ Route</TableCell>
              <TableCell sx={{ fontWeight: 700 }}>💡 Aktiv</TableCell>
              <TableCell sx={{ fontWeight: 700 }}>🔍 Details</TableCell>
            </TableRow>
            </TableHead>
            <TableBody>
            {layoutRows.map(r => {
              const idx = steps.findIndex(s => s.id === r.step.id);
              const typeStyle = getTypeStyle(r.step.type);
              const promptText = resolvePromptText(r.step);
              const promptLabel = promptText ?? (typeof r.step.promptId === 'number' ? `Prompt #${r.step.promptId}` : 'Noch kein Prompt ausgewählt');
              const routeKey = r.step.route || ROOT;
              const routeTone = getRouteColor(routeKey);
              return (
                  <>
                    <TableRow
                        key={r.step.id}
                        sx={{
                          backgroundColor: alpha(typeStyle.color, 0.04),
                          '&:hover': { backgroundColor: alpha(typeStyle.color, 0.1) },
                          transition: 'background-color 0.2s ease',
                          borderLeft: `4px solid ${alpha(typeStyle.color, 0.45)}`,
                        }}
                    >
                      <TableCell sx={{ width: 90 }}>
                        <Box sx={{ display: 'flex', alignItems: 'center', pl: r.depth * 2 }}>
                          <Chip
                              size="small"
                              label={r.rowLabel}
                              sx={{
                                fontWeight: 600,
                                bgcolor: alpha(typeStyle.color, 0.16),
                                color: '#0f172a',
                              }}
                          />
                        </Box>
                      </TableCell>
                      <TableCell sx={{ whiteSpace: 'nowrap' }}>
                        <Tooltip title="Nach oben verschieben">
                          <IconButton size="small" onClick={() => moveStep(idx, idx - 1)}>
                            <ArrowUpwardIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                        <Tooltip title="Nach unten verschieben">
                          <IconButton size="small" onClick={() => moveStep(idx, idx + 1)}>
                            <ArrowDownwardIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                        <Tooltip title="Neuen Schritt darunter einfügen">
                          <IconButton size="small" onClick={() => {
                            setInsertPos(idx + 1);
                            setDraft({ ...(r.step as any), id: uuid() });
                          }}>
                            <AddIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      </TableCell>
                      <TableCell sx={{ minWidth: 220 }}>
                        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                          <Typography sx={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: 1, color: typeStyle.color }}>
                            <span>{typeStyle.emoji}</span> {typeStyle.title}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            {typeStyle.description}
                          </Typography>
                        </Box>
                      </TableCell>
                      <TableCell sx={{ minWidth: 280 }}>
                        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                          <Typography variant="subtitle2" sx={{ fontWeight: 700, whiteSpace: 'pre-line' }}>
                            {promptLabel}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            {typeStyle.emoji} ID #{r.step.promptId ?? '—'} • Vollständiger Promptname im Überblick
                          </Typography>
                        </Box>
                      </TableCell>
                      <TableCell sx={{ minWidth: 120 }}>
                        <Typography fontWeight={600} color={r.step.type === 'DecisionPrompt' ? 'success.main' : 'text.disabled'}>
                          {r.step.type === 'DecisionPrompt' ? (r.step.yesKey || '—') : '—'}
                        </Typography>
                      </TableCell>
                      <TableCell sx={{ minWidth: 120 }}>
                        <Typography fontWeight={600} color={r.step.type === 'DecisionPrompt' ? 'error.main' : 'text.disabled'}>
                          {r.step.type === 'DecisionPrompt' ? (r.step.noKey || '—') : '—'}
                        </Typography>
                      </TableCell>
                      <TableCell sx={{ minWidth: 160 }}>
                        <Chip
                            label={routeKey === ROOT ? '🌳 Root' : `🛣️ ${routeKey}`}
                            sx={{
                              bgcolor: alpha(routeTone, 0.2),
                              color: routeTone,
                              fontWeight: 600,
                              mb: 1,
                            }}
                        />
                        <Select
                            fullWidth
                            size="small"
                            value={routeKey}
                            onChange={e => handleRouteChange(r.step.id, e.target.value as string)}
                        >
                          {routeKeysUpTo(idx).map(k => (<MenuItem key={k} value={k}>{k}</MenuItem>))}
                        </Select>
                      </TableCell>
                      <TableCell>
                        <Checkbox
                            checked={r.step.active !== false}
                            onChange={e => usePipelineStore.getState().updateStep(r.step.id, { active: e.target.checked }).catch(err => setError(String(err)))}
                            color="success"
                        />
                      </TableCell>
                      <TableCell sx={{ minWidth: 180 }}>
                        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                          {r.warnings.map((w, i) => (
                              <Chip
                                  key={i}
                                  label={w}
                                  size="small"
                                  variant="outlined"
                                  sx={{ mr: 0.5, borderColor: '#f59e0b', color: '#b45309', backgroundColor: 'rgba(245, 158, 11, 0.08)' }}
                              />
                          ))}
                          <Tooltip title="Schritt löschen">
                            <IconButton color="error" onClick={() => removeStep(r.step.id).catch(err => setError(String(err)))}>
                              <DeleteIcon />
                            </IconButton>
                          </Tooltip>
                          <Button size="small" variant="outlined" onClick={() => setEdit(r.step)}>
                            ✏️ Bearbeiten
                          </Button>
                        </Stack>
                      </TableCell>
                    </TableRow>

                    {r.step.type === 'DecisionPrompt' && (
                        <TableRow>
                          <TableCell colSpan={totalCols} sx={{ p: 0 }}>
                            <Box
                                width="100%"
                                height="4px"
                                sx={{ backgroundColor: alpha(routeTone, 0.35) }}
                            />
                          </TableCell>
                        </TableRow>
                    )}
                  </>
              );
            })}
          </TableBody>
        </Table>
        </TableContainer>

        {/* EDIT Drawer */}
        <Drawer open={!!edit} onClose={closeEdit} anchor="right">
          {edit && (
              <Box sx={{ p:2, width: 360, display:'flex', flexDirection:'column', gap:2 }}>
                <Select
                    fullWidth
                    value={edit.type}
                    onChange={async (e)=>{
                      const val=e.target.value as string;
                      await updateStep(edit.id,{type:val});
                      await tryPersistPipeline();
                    }}
                >
                  <MenuItem value="ExtractionPrompt">ExtractionPrompt</MenuItem>
                  <MenuItem value="ScoringPrompt">ScoringPrompt</MenuItem>
                  <MenuItem value="DecisionPrompt">DecisionPrompt</MenuItem>
                </Select>

                <Select
                    fullWidth
                    value={edit.promptId}
                    onChange={async (e)=>{
                      await updateStep(edit.id,{promptId:Number(e.target.value)});
                      await tryPersistPipeline();
                    }}
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
                        onChange={async (cfg)=> {
                          await updateStep(edit.id, { config: cfg } as any);
                        }}
                        onPersist={tryPersistPipeline}
                    />
                )}

                <Select
                    fullWidth
                    value={edit.route||ROOT}
                    onChange={async (e)=>{
                      await handleRouteChange(edit.id, e.target.value as string);
                    }}
                >
                  {routeKeysUpTo(steps.findIndex(s=>s.id===edit.id)).map(k => (
                      <MenuItem key={k} value={k}>{k}</MenuItem>
                  ))}
                </Select>
              </Box>
          )}
        </Drawer>

        {/* DRAFT Drawer */}
        <Drawer open={!!draft} onClose={closeDraft} anchor="right">
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
                        onPersist={tryPersistPipeline}
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
                  <Button variant="outlined" onClick={closeDraft}>Cancel</Button>
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
