import { useState, useEffect, useMemo } from 'react';
import {
  Box, Table, TableHead, TableRow, TableCell, TableBody, IconButton,
  Button, Drawer, TextField, Select, MenuItem, Checkbox, Snackbar, Alert, Typography, Chip
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import AddIcon from '@mui/icons-material/Add';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import debounce from 'lodash.debounce';
import { usePipelineStore, PipelineStep } from '../hooks/usePipelineStore';
import { useBranchLayout, LayoutRow } from '../hooks/useBranchLayout';
import StepBranchPanel from './PipelineEditor/StepBranchPanel';
import BranchHeader from './PipelineEditor/BranchHeader';
import { useNavigate } from 'react-router-dom';
import uuid from '../utils/uuid';

interface PromptOption { id: number; text: string; }
const API = import.meta.env.VITE_API_URL || 'http://localhost:8084';
const PROMPT_API = import.meta.env.VITE_PROMPT_URL || 'http://localhost:8082';

/* move helper before component to avoid hoisting quirks */
function branchColor(key?: string) {
  const map: Record<string, string> = { true: '#4caf50', false: '#f44336', maybe: '#2196f3' };
  return map[key ?? ''] ?? '#9e9e9e';
}

export default function PipelineEditor() {
  const {
    name, steps, updateName,
    addStepAt, updateStep, reorder, removeStep,
    currentPipelineId, dirty, confirmIfDirty
  } = usePipelineStore();
  const navigate = useNavigate();
  const [edit, setEdit] = useState<PipelineStep | null>(null);
  const [draft, setDraft] = useState<PipelineStep | null>(null);
  const [insertPos, setInsertPos] = useState<number>(steps.length);
  const [promptOptions, setPromptOptions] = useState<Record<string, PromptOption[]>>({});
  const [error, setError] = useState('');
  const debounced = useMemo(() => debounce(updateName, 300), [updateName]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const toggleCollapse = (cKey: string) =>
    setCollapsed(c => ({ ...c, [cKey]: !c[cKey] }));

  /* memo‑ise hierarchical rows */
  const layoutRows = useMemo<LayoutRow[]>(() => useBranchLayout(steps), [steps]);


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
    addStepAt(insertPos, draft)
      .then(() => setDraft(null))
      .catch(e => setError(String(e)));
  };

  const moveStep = (from: number, to: number) => {
    if (to < 0 || to >= steps.length) return;
    const order = [...steps.map(s => s.id)];
    const [id] = order.splice(from, 1);
    order.splice(to, 0, id);
    reorder(order).catch(e => setError(String(e)));
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
        <TextField size="small" label="Name" value={name}
          onChange={e=>debounced(e.target.value)} />
        <Button startIcon={<AddIcon/>}
          onClick={() => { setInsertPos(steps.length); setDraft({ id: uuid(), label:'', type:'ExtractionPrompt', promptId:0, active:true }); }}>
          Step
        </Button>
      </Box>
      <Table className="table">
            <TableHead>
              <TableRow>
                <TableCell>#</TableCell>
                <TableCell></TableCell>
                <TableCell>Label</TableCell>
                  <TableCell>Type</TableCell>
                  <TableCell>Prompt</TableCell>
                  <TableCell>Input Source</TableCell>
                  <TableCell>Alias</TableCell>
                  <TableCell>Inputs</TableCell>
                  <TableCell>Route</TableCell>
                  <TableCell>Condition</TableCell>
                  <TableCell>Active</TableCell>
                  <TableCell></TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {layoutRows.map(r => (
                  r.isBranchHeader ? (
                    <TableRow key={`bh-${r.cKey}`}>
                      <TableCell colSpan={12} sx={{ bgcolor: '#f5f5f5', p: 0 }}>
                        <BranchHeader
                          branchKey={r.branchKey!}
                          collapsed={!!collapsed[r.cKey!]}
                          onToggle={()=>toggleCollapse(r.cKey!)}
                          onAdd={()=>{
            /* insert directly after the last row inside this branch */
            const lastRowIndex = layoutRows
               .filter(x=>x.cKey===r.cKey && !x.isBranchHeader)
               .map(x=>steps.findIndex(s=>s.id===x.step.id))
               .reduce((a,b)=>Math.max(a,b), -1) + 1;
            setInsertPos(lastRowIndex);
            setDraft({ id: uuid(), label:'', type:'ExtractionPrompt', promptId:0, active:true });
          }}
                        />
                      </TableCell>
                    </TableRow>
                  ) : collapsed[r.cKey || ''] ? null : (() => {
                    const idx = steps.findIndex(s => s.id === r.step.id);
                    return (
                      <TableRow key={r.step.id}>
                        <TableCell sx={{ pl:r.depth*4, borderLeft:r.depth ? `4px solid ${branchColor(r.branchKey)}`:undefined }}>
                          {r.rowIdx}
                        </TableCell>
                        <TableCell>
                          <IconButton size="small" onClick={() => moveStep(idx, idx - 1)}><ArrowUpwardIcon fontSize="small" /></IconButton>
                          <IconButton size="small" onClick={() => moveStep(idx, idx + 1)}><ArrowDownwardIcon fontSize="small" /></IconButton>
                          <IconButton size="small" onClick={() => { setInsertPos(idx + 1); setDraft({ ...r.step, id: uuid() }); }}><AddIcon fontSize="small" /></IconButton>
                        </TableCell>
                        <TableCell>{r.step.label}</TableCell>
                        <TableCell>{r.step.type}</TableCell>
                        <TableCell>{r.step.promptId}</TableCell>
                        <TableCell>{r.step.inputSource}</TableCell>
                        <TableCell>{r.step.alias}</TableCell>
                        <TableCell>{(r.step.inputs || []).join(',')}</TableCell>
                        <TableCell>{r.step.route || '—'}</TableCell>
                        <TableCell>{r.step.condition}</TableCell>
                        <TableCell><Checkbox checked={r.step.active !== false} onChange={e => updateStep(r.step.id, { active: e.target.checked }).catch(err => setError(String(err)))} /></TableCell>
                        <TableCell>
                          {r.isBranchEnd && (
                            <Chip
                              label={`merge→${r.step.mergeTo || '—'}`}
                              size="small"
                              onClick={() => setEdit(r.step)}
                              color="info"
                              variant="outlined"
                            />
                          )}
                          <IconButton onClick={() => removeStep(r.step.id).catch(err => setError(String(err)))}><DeleteIcon /></IconButton>
                          <Button size="small" onClick={() => setEdit(r.step)}>Edit</Button>
                        </TableCell>
                      </TableRow>
                    );
                  })()
                ))}
              </TableBody>
      </Table>
      <Drawer open={!!edit} onClose={() => setEdit(null)} anchor="right">
        {edit && (
          <Box sx={{ p:2, width: 320, display:'flex', flexDirection:'column', gap:2 }}>
            <TextField label="Label" value={edit.label||''} onChange={e=>updateStep(edit.id,{label:e.target.value}).catch(er=>setError(String(er)))} />
            <Select fullWidth value={edit.type} onChange={e=>{const val=e.target.value as string; updateStep(edit.id,{type:val}).catch(er=>setError(String(er)));}}>
              <MenuItem value="ExtractionPrompt">ExtractionPrompt</MenuItem>
              <MenuItem value="ScoringPrompt">ScoringPrompt</MenuItem>
              <MenuItem value="DecisionPrompt">DecisionPrompt</MenuItem>
            </Select>
            <Select fullWidth value={edit.promptId} onChange={e=>updateStep(edit.id,{promptId:Number(e.target.value)}).catch(er=>setError(String(er)))}>
              {(promptOptions[edit.type]||[]).map(p=>(<MenuItem key={p.id} value={p.id}>{p.text}</MenuItem>))}
            </Select>
            <TextField label="Route" fullWidth value={edit.route || ''}
              onChange={e=>updateStep(edit.id,{route:e.target.value || null}).catch(er=>setError(String(er)))} />
            {edit.type==='ExtractionPrompt' && (
              <>
                <Select fullWidth value={edit.inputSource||'document'} onChange={e=>updateStep(edit.id,{inputSource:e.target.value as string}).catch(er=>setError(String(er)))}>
                  <MenuItem value="document">document</MenuItem>
                  {steps.filter(s=>s.alias).map(s=>(<MenuItem key={s.id} value={s.alias!}>{s.alias}</MenuItem>))}
                </Select>
                <TextField fullWidth label="Alias" value={edit.alias||''} onChange={e=>updateStep(edit.id,{alias:e.target.value}).catch(er=>setError(String(er)))} />
              </>
            )}
            {edit.type==='ScoringPrompt' && (
              <>
                <Select multiple fullWidth value={edit.inputs||[]} onChange={e=>updateStep(edit.id,{inputs:Array.from(e.target.value as any)}).catch(er=>setError(String(er)))}>
                  {steps.filter(s=>s.alias).map(s=>(<MenuItem key={s.id} value={s.alias!}>{s.alias}</MenuItem>))}
                </Select>
                <TextField label="Formula" fullWidth value={edit.formulaOverride||''} onChange={e=>updateStep(edit.id,{formulaOverride:e.target.value}).catch(er=>setError(String(er)))} />
              </>
            )}
            {edit.type==='DecisionPrompt' && (
              <>
                <TextField label="Condition" fullWidth value={edit.condition||''} onChange={e=>updateStep(edit.id,{condition:e.target.value}).catch(er=>setError(String(er)))} />
                <StepBranchPanel step={edit} />
              </>
            )}
            {edit.type!=='DecisionPrompt' && (
              <Select fullWidth value={edit.mergeTo||''}
                      onChange={e=>updateStep(edit.id,{mergeTo:e.target.value||undefined}).catch(er=>setError(String(er)))}>
                <MenuItem value="">(linear)</MenuItem>
                {steps.map(s=>(<MenuItem key={s.id} value={s.id}>{s.id}</MenuItem>))}
              </Select>
            )}
          </Box>
        )}
      </Drawer>
      <Drawer open={!!draft} onClose={() => setDraft(null)} anchor="right">
        {draft && (
          <Box sx={{ p:2, width:320, display:'flex', flexDirection:'column', gap:2 }}>
            <TextField label="Label" value={draft.label||''} onChange={e=>setDraft({...draft, label:e.target.value})} />
            <Select fullWidth value={draft.type} onChange={e=>{const val=e.target.value as string; setDraft({...draft, type:val}); fetchPrompts(val);}}>
              <MenuItem value="ExtractionPrompt">ExtractionPrompt</MenuItem>
              <MenuItem value="ScoringPrompt">ScoringPrompt</MenuItem>
              <MenuItem value="DecisionPrompt">DecisionPrompt</MenuItem>
            </Select>
            <Select fullWidth value={draft.promptId} onChange={e=>setDraft({...draft, promptId:Number(e.target.value)})}>
              {(promptOptions[draft.type]||[]).map(p=>(<MenuItem key={p.id} value={p.id}>{p.text}</MenuItem>))}
            </Select>
            <TextField label="Route" fullWidth value={draft.route||''} onChange={e=>setDraft({...draft, route: e.target.value || undefined})} />
            {draft.type==='ExtractionPrompt' && (
              <>
                <Select fullWidth value={draft.inputSource||'document'} onChange={e=>setDraft({...draft,inputSource:e.target.value as string})}>
                  <MenuItem value="document">document</MenuItem>
                  {steps.filter(s=>s.alias).map(s=>(<MenuItem key={s.id} value={s.alias!}>{s.alias}</MenuItem>))}
                </Select>
                <TextField fullWidth label="Alias" value={draft.alias||''} onChange={e=>setDraft({...draft, alias:e.target.value})} />
              </>
            )}
            {draft.type==='ScoringPrompt' && (
              <>
                <Select multiple fullWidth value={draft.inputs||[]} onChange={e=>setDraft({...draft, inputs:Array.from(e.target.value as any)})}>
                  {steps.filter(s=>s.alias).map(s=>(<MenuItem key={s.id} value={s.alias!}>{s.alias}</MenuItem>))}
                </Select>
                <TextField label="Formula" fullWidth value={draft.formulaOverride||''} onChange={e=>setDraft({...draft, formulaOverride:e.target.value})} />
              </>
            )}
            {draft.type==='DecisionPrompt' && (
              <TextField label="Condition" fullWidth value={draft.condition||''} onChange={e=>setDraft({...draft, condition:e.target.value})} />
            )}
            {draft.type!=='DecisionPrompt' && (
              <Select fullWidth value={draft.mergeTo||''}
                      onChange={e=>setDraft({...draft, mergeTo:e.target.value||undefined})}>
                <MenuItem value="">(linear)</MenuItem>
                {steps.map(s=>(<MenuItem key={s.id} value={s.id}>{s.id}</MenuItem>))}
              </Select>
            )}
            <Box sx={{ display:'flex', justifyContent:'flex-end', mt:2 }}>
              <Button variant="outlined" onClick={() => setDraft(null)}>Cancel</Button>
              <Button variant="contained" onClick={saveNewStep}>Add</Button>
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

