import React, { useCallback, useEffect, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import { Box, Typography, Paper, Select, MenuItem, Button, FormControl, InputLabel, OutlinedInput, Chip } from '@mui/material';

interface Prompt { id: number; text: string }

export default function Upload() {
  const [file, setFile] = useState<File | null>(null);
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [result, setResult] = useState<string>('');

  useEffect(() => {
    fetch('http://localhost:8082/prompts')
      .then(r => r.json())
      .then(setPrompts);
  }, []);

  const onDrop = useCallback((files: File[]) => {
    setFile(files[0]);
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({ onDrop });

  const analyze = () => {
    if (!file) return;
    const form = new FormData();
    form.append('file', file);
    const texts = prompts.filter(p => selected.includes(p.id)).map(p => p.text).join(',');
    form.append('prompts', texts);
    fetch('http://localhost:8084/classify', { method: 'POST', body: form })
      .then(r => r.json())
      .then(d => setResult(d.regress ? 'Regressfall' : 'Kein Regressfall'));
  };

  return (
    <Box>
      <Typography variant="h4" gutterBottom>Upload PDF</Typography>
      <Paper {...getRootProps()} sx={{ p: 4, textAlign: 'center', border: '2px dashed #bbb', mb:2 }}>
        <input {...getInputProps()} />
        {isDragActive ? <p>Drop the file here...</p> : <p>{file ? file.name : "Drag 'n' drop file here, or click to select"}</p>}
      </Paper>
      <FormControl fullWidth sx={{ mb:2 }}>
        <InputLabel id="prompt-label">Prompts</InputLabel>
        <Select
          labelId="prompt-label"
          multiple
          value={selected}
          onChange={e => setSelected(typeof e.target.value === 'string' ? [] : e.target.value as number[])}
          input={<OutlinedInput label="Prompts" />}
          renderValue={(selectedIds) => (
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
              {(selectedIds as number[]).map(id => {
                const t = prompts.find(p => p.id === id)?.text || id;
                return <Chip key={id} label={t} />;
              })}
            </Box>
          )}
        >
          {prompts.map(p => (
            <MenuItem key={p.id} value={p.id}>{p.text}</MenuItem>
          ))}
        </Select>
      </FormControl>
      <Button variant="contained" onClick={analyze} disabled={!file}>Analyze</Button>
      {result && <Typography sx={{ mt:2 }}>Result: {result}</Typography>}
    </Box>
  );
}
