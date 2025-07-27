import { useState, useEffect } from 'react';
import {
  Box, Table, TableHead, TableRow, TableCell, TableBody, IconButton, Button,
  Drawer, TextField, Select, MenuItem, Checkbox
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import AddIcon from '@mui/icons-material/Add';
import { DragDropContext, Droppable, Draggable } from 'react-beautiful-dnd';
import { usePipelineStore, PipelineStep } from '../hooks/usePipelineStore';

const API = import.meta.env.VITE_API_URL || 'http://localhost:8090';

export default function Pipeline() {
  const {
    steps,
    name,
    currentPipelineId,
    addStepAt,
    updateStep,
    removeStep,
    moveStep,
    loadSteps,
    setName,
  } = usePipelineStore();
  const [edit, setEdit] = useState<PipelineStep | null>(null);
  const [promptOptions, setPromptOptions] = useState<{ id: number; text: string }[]>([]);
  const [list, setList] = useState<{ id: string; name: string }[]>([]);

  const handleDrag = (result: any) => {
    if (!result.destination) return;
    moveStep(result.source.index, result.destination.index);
  };

  useEffect(() => {
    if (edit?.type) {
      fetch(`${API}/prompts?type=${edit.type}`)
        .then(r => r.json())
        .then(setPromptOptions)
        .catch(() => setPromptOptions([]));
    }
  }, [edit?.type]);

  const save = () => {
    fetch(`${API}/pipelines${currentPipelineId ? '/' + currentPipelineId : ''}`, {
      method: currentPipelineId ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, steps }),
    })
      .then(r => r.json())
      .then((res: any) => loadSteps(res.steps, res.id, res.name))
      .catch(e => console.error('save pipeline', e));
  };

  const load = () => {
    fetch(`${API}/pipelines`)
      .then(r => r.json())
      .then((l: any[]) => {
        setList(l);
        const id = window.prompt('Pipeline ID', l[0]?.id || '');
        if (id) {
          fetch(`${API}/pipelines/${id}`)
            .then(r => r.json())
            .then((cfg: any) => loadSteps(cfg.steps, id, cfg.name));
        }
      })
      .catch(e => console.error('load list', e));
  };

  return (
    <Box>
      <Box sx={{ mb:2, display:'flex', gap:1, alignItems:'center' }}>
        <TextField size="small" label="Name" value={name} onChange={e=>setName(e.target.value)} />
        <Button startIcon={<AddIcon />} onClick={() => addStepAt(steps.length)}>Step</Button>
        <Button variant="outlined" onClick={save}>Save</Button>
        <Button variant="outlined" onClick={load}>Load</Button>
        <Button variant="outlined" onClick={() => {
          const blob = new Blob([JSON.stringify(steps, null, 2)], {type:'application/json'});
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'pipeline.json';
          a.click();
        }}>Export</Button>
        <Button variant="outlined" component="label">Import<input hidden type="file" accept="application/json" onChange={e=>{
          const f=e.target.files?.[0]; if(!f) return; const r=new FileReader();
          r.onload=ev=>{ try{ const s=JSON.parse(ev.target?.result as string); loadSteps(s); }catch(err){ console.error(err);} }; r.readAsText(f);
        }}/></Button>
      </Box>
      <DragDropContext onDragEnd={handleDrag}>
        <Droppable droppableId="steps">
          {p => (
            <Table ref={p.innerRef} {...p.droppableProps}>
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
                  <TableCell>Condition</TableCell>
                  <TableCell>Active</TableCell>
                  <TableCell></TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {steps.map((s, i) => (
                  <Draggable draggableId={s.id} index={i} key={s.id}>
                    {prov => (
                      <TableRow ref={prov.innerRef} {...prov.draggableProps} {...prov.dragHandleProps}>
                        <TableCell>{i + 1}</TableCell>
                        <TableCell>
                          <IconButton size="small" onClick={() => addStepAt(i+1)}><AddIcon fontSize="small"/></IconButton>
                        </TableCell>
                        <TableCell>{s.label || ''}</TableCell>
                        <TableCell>{s.type || ''}</TableCell>
                        <TableCell>{s.promptId}</TableCell>
                        <TableCell>{s.input_source}</TableCell>
                        <TableCell>{s.alias}</TableCell>
                        <TableCell>{(s.inputs||[]).join(',')}</TableCell>
                        <TableCell>{s.condition?.slice(0,24) || ''}</TableCell>
                        <TableCell><Checkbox checked={s.active !== false} onChange={e=>updateStep(s.id,{active:e.target.checked})}/></TableCell>
                        <TableCell>
                          <IconButton onClick={() => removeStep(s.id)}><DeleteIcon /></IconButton>
                          <Button size="small" onClick={() => setEdit(s)}>Edit</Button>
                        </TableCell>
                      </TableRow>
                    )}
                  </Draggable>
                ))}
                {p.placeholder}
              </TableBody>
            </Table>
          )}
        </Droppable>
      </DragDropContext>
      <Drawer open={!!edit} onClose={() => setEdit(null)} anchor="right">
        {edit && (
          <Box sx={{ p:2, width: 300, display:'flex', flexDirection:'column', gap:2 }}>
            <TextField label="Label" value={edit.label||''} onChange={e=>updateStep(edit.id,{label:e.target.value})}/>
            <Select fullWidth value={edit.type || ''} onChange={e => updateStep(edit.id, { type: e.target.value as string })}>
              <MenuItem value="ExtractionPrompt">ExtractionPrompt</MenuItem>
              <MenuItem value="ScoringPrompt">ScoringPrompt</MenuItem>
              <MenuItem value="DecisionPrompt">DecisionPrompt</MenuItem>
            </Select>
            <Select fullWidth value={edit.promptId||''} onChange={e=>updateStep(edit.id,{promptId: Number(e.target.value)})}>
              {promptOptions.map(p => (
                <MenuItem key={p.id} value={p.id}>{p.text}</MenuItem>
              ))}
            </Select>
            {edit.type === 'ExtractionPrompt' && (
              <>
                <Select fullWidth value={edit.input_source||'document'} onChange={e=>updateStep(edit.id,{input_source:e.target.value})}>
                  <MenuItem value="document">document</MenuItem>
                  {steps.filter(s=>s.alias).map(s=> (
                    <MenuItem key={s.id} value={s.alias!}>{s.alias}</MenuItem>
                  ))}
                </Select>
                <TextField fullWidth label="Alias" value={edit.alias||''} onChange={e=>updateStep(edit.id,{alias:e.target.value})}/>
              </>
            )}
            {edit.type === 'ScoringPrompt' && (
              <>
                <Select
                  multiple
                  fullWidth
                  value={edit.inputs||[]}
                  onChange={e=>updateStep(edit.id,{inputs: Array.from(e.target.value as any)})}
                >
                  {steps.filter(s=>s.alias).map(s=> (
                    <MenuItem key={s.id} value={s.alias!}>{s.alias}</MenuItem>
                  ))}
                </Select>
                <TextField label="Formula" fullWidth value={edit.formula_override||''} onChange={e=>updateStep(edit.id,{formula_override:e.target.value})}/>
              </>
            )}
            {edit.type === 'DecisionPrompt' && (
              <>
                <TextField label="Condition" fullWidth value={edit.condition||''} onChange={e=>updateStep(edit.id,{condition:e.target.value})}/>
                {edit.enum_targets ? (
                  Object.entries(edit.enum_targets).map(([k,v]) => (
                    <Select key={k} fullWidth value={v} onChange={e=>updateStep(edit.id,{enum_targets:{...edit.enum_targets!,[k]:e.target.value as string}})}>
                      {steps.map(s=> (
                        <MenuItem key={s.id} value={s.id}>{s.label||s.id}</MenuItem>
                      ))}
                    </Select>
                  ))
                ) : (
                  <>
                    <Select fullWidth value={edit.true_target||''} onChange={e=>updateStep(edit.id,{true_target:e.target.value})}>
                      {steps.map(s=> (
                        <MenuItem key={s.id} value={s.id}>{s.label||s.id}</MenuItem>
                      ))}
                    </Select>
                    <Select fullWidth value={edit.false_target||''} onChange={e=>updateStep(edit.id,{false_target:e.target.value})}>
                      {steps.map(s=> (
                        <MenuItem key={s.id} value={s.id}>{s.label||s.id}</MenuItem>
                      ))}
                    </Select>
                  </>
                )}
              </>
            )}
            <Box>
              <Checkbox checked={edit.active !== false} onChange={e=>updateStep(edit.id,{active:e.target.checked})}/> Active
            </Box>
          </Box>
        )}
      </Drawer>
    </Box>
  );
}
