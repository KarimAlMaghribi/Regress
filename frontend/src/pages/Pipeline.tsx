import React, { useEffect, useState } from 'react';
import {
  Box, Paper, Typography, Checkbox, FormControlLabel, Button,
  FormControl, InputLabel, Select, MenuItem, Snackbar, Alert
} from '@mui/material';
import PageHeader from '../components/PageHeader';

interface Prompt { id: number; text: string }
interface TextEntry { id: number }

export default function Pipeline() {
  const [pdfs, setPdfs] = useState<TextEntry[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [promptId, setPromptId] = useState<number | ''>('');
  const [snack, setSnack] = useState('');

  const load = () => {
    fetch('http://localhost:8083/texts')
      .then(r => r.json())
      .then(setPdfs)
      .catch(e => setSnack(`Fehler: ${e}`));
    fetch('http://localhost:8082/prompts')
      .then(r => r.json())
      .then(setPrompts)
      .catch(e => setSnack(`Fehler: ${e}`));
  };

  useEffect(load, []);

  const toggle = (id: number, checked: boolean) => {
    setSelected(s => checked ? [...s, id] : s.filter(i => i !== id));
  };

  const start = () => {
    const prompt = prompts.find(p => p.id === promptId)?.text;
    if (!prompt || selected.length === 0) return;
    fetch('http://localhost:8083/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: selected, prompt })
    }).then(() => {
      setSnack('Analyse gestartet');
      setSelected([]);
    }).catch(e => setSnack(`Fehler: ${e}`));
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
        <InputLabel id="prompt-label">Prompt</InputLabel>
        <Select labelId="prompt-label" value={promptId} label="Prompt" onChange={e => setPromptId(e.target.value as number)}>
          <MenuItem value=""><em>Prompt wählen</em></MenuItem>
          {prompts.map(p => (
            <MenuItem key={p.id} value={p.id}>{p.text}</MenuItem>
          ))}
        </Select>
      </FormControl>
      <Button variant="contained" disabled={!selected.length || promptId === ''} onClick={start}>Analyse starten</Button>
      <Snackbar open={!!snack} autoHideDuration={4000} onClose={() => setSnack('')}>
        <Alert onClose={() => setSnack('')} severity="info">{snack}</Alert>
      </Snackbar>
    </Box>
  );
}
