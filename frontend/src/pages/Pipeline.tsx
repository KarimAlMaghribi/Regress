import React, { useEffect, useState } from 'react';
import {
  Box,
  Paper,
  Typography,
  Checkbox,
  FormControlLabel,
  Button,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Snackbar,
  Alert,
  ListItemText,
} from '@mui/material';
import PageHeader from '../components/PageHeader';

interface Prompt { id: number; text: string; weight: number; favorite: boolean }
interface TextEntry { id: number }

export default function Pipeline() {
  const [pdfs, setPdfs] = useState<TextEntry[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [promptIds, setPromptIds] = useState<number[]>([]);
  const [snack, setSnack] = useState('');
  // Results are displayed in the history section, not directly in the pipeline
  // view. Therefore we only keep a snackbar for feedback here.
  
  const load = () => {
    fetch('http://localhost:8083/texts')
      .then(r => r.json())
      .then(setPdfs)
      .catch(e => setSnack(`Fehler: ${e}`));
    fetch('http://localhost:8082/prompts')
      .then(async r => {
        const json = await r.json();
        if (!r.ok) throw new Error(json.error || r.statusText);
        return json as any[];
      })
      .then((d: any[]) => setPrompts(d.map(p => ({ ...p, weight: p.weight ?? 1, favorite: !!p.favorite }))))
      .catch(e => setSnack(`Fehler: ${e}`));
  };

  useEffect(load, []);

  const sortedPrompts = [...prompts].sort((a, b) => Number(b.favorite) - Number(a.favorite));

  const toggle = (id: number, checked: boolean) => {
    setSelected(s => checked ? [...s, id] : s.filter(i => i !== id));
  };

  const start = () => {
    const chosen = promptIds
      .map(id => prompts.find(p => p.id === id))
      .filter(Boolean) as Prompt[];
    if (chosen.length === 0 || selected.length === 0) return;
    const payloadPrompts = chosen.map(p => ({ text: p.text, weight: p.weight }));
    const prompt = JSON.stringify(payloadPrompts);
    fetch('http://localhost:8083/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: selected, prompt })
    })
      .then(() => {
        setSnack('Analyse gestartet');
        setSelected([]);
      })
      .catch(e => setSnack(`Fehler: ${e}`));
  };

  return (
    <Box>
      <PageHeader title="Pipeline" breadcrumb={[{ label: 'Dashboard', to: '/' }, { label: 'Pipeline' }]} />
      <Paper sx={{ p:2, mb:2 }}>
        <Typography variant="subtitle1" gutterBottom>PDFs</Typography>
        {pdfs.map(p => (
          <FormControlLabel key={p.id} control={<Checkbox checked={selected.includes(p.id)} onChange={e => toggle(p.id, e.target.checked)} />} label={`PDF ${p.id}`} />
        ))}
        {pdfs.length === 0 && <Typography>Keine PDFs vorhanden</Typography>}
      </Paper>
      <FormControl size="small" sx={{ minWidth: 220, mb:2 }}>
        <InputLabel id="prompt-label">Prompts</InputLabel>
        <Select
          labelId="prompt-label"
          multiple
          value={promptIds}
          onChange={e => setPromptIds(typeof e.target.value === 'string' ? e.target.value.split(',').map(Number) : e.target.value as number[])}
          renderValue={sel => (sel as number[]).map(id => prompts.find(p => p.id === id)?.text).join(', ')}
        >
          {sortedPrompts.map(p => (
            <MenuItem key={p.id} value={p.id}>
              <Checkbox checked={promptIds.indexOf(p.id) > -1} />
              <ListItemText primary={`${p.text} (${p.weight ?? 1})`} />
            </MenuItem>
          ))}
        </Select>
      </FormControl>
      <Button
        variant="contained"
        disabled={!selected.length || promptIds.length === 0}
        onClick={start}
      >
        Analyse starten
      </Button>
      <Snackbar open={!!snack} autoHideDuration={4000} onClose={() => setSnack('')}>
        <Alert onClose={() => setSnack('')} severity="info">{snack}</Alert>
      </Snackbar>
    </Box>
  );
}
