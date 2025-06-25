import React, { useCallback, useEffect, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import {
  Box, Typography, Paper, Select, MenuItem, Button,
  FormControl, InputLabel, OutlinedInput, Chip
} from '@mui/material';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import { motion } from 'framer-motion';
import PageHeader from '../components/PageHeader';

interface Prompt { id: number; text: string }

export default function Upload() {
  const [file, setFile] = useState<File | null>(null);
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [result, setResult] = useState<string>('');
  const [uploadId, setUploadId] = useState<string>('');

  useEffect(() => {
    console.log('Loading prompts ...');
    fetch('http://localhost:8082/prompts')
      .then(r => r.json())
      .then(d => {
        console.log('Loaded prompts', d.length);
        setPrompts(d);
      });
  }, []);

  const onDrop = useCallback((files: File[]) => {
    console.log('Selected file', files[0]);
    setFile(files[0]);
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({ onDrop });

  const analyze = () => {
    if (!file) return;
    console.log('Analyzing file', file.name);
    const form = new FormData();
    form.append('file', file);
    const texts = prompts
      .filter(p => selected.includes(p.id))
      .map(p => p.text)
      .join(',');
    form.append('prompts', texts);
    const ingest = import.meta.env.VITE_INGEST_URL || 'http://localhost:8081';
    const classifier = import.meta.env.VITE_CLASSIFIER_URL || 'http://localhost:8084';
    fetch(`${ingest}/upload`, { method: 'POST', body: form })
      .then(async r => {
        if (!r.ok) {
          const text = await r.text();
          throw new Error(text || `HTTP ${r.status}`);
        }
        return r.json();
      })
      .then(d => {
        console.log('Upload result', d);
        setUploadId(d.id);
        setResult('Processing...');
        pollResult(classifier, d.id);
      })
      .catch(err => {
        console.error('Upload error', err);
        setResult(`Error: ${(err as Error).message}`);
      });
  };

  const pollResult = async (classifier: string, id: string) => {
    while (true) {
      try {
        const res = await fetch(`${classifier}/results/${id}`);
        if (res.status === 404 || res.status === 202) {
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        if (!res.ok) {
          const text = await res.text();
          throw new Error(text || `HTTP ${res.status}`);
        }
        const d = await res.json();
        setResult(d.regress ? 'Regressfall' : 'Kein Regressfall');
        break;
      } catch (err) {
        console.error('Polling error', err);
        setResult(`Error: ${(err as Error).message}`);
        break;
      }
    }
  };

  const dropStyles = {
    p: 6,
    border: '2px dashed',
    borderColor: 'primary.main',
    borderRadius: 3,
    textAlign: 'center',
    cursor: 'pointer',
    background:
      'linear-gradient(135deg, rgba(108,93,211,0.1), rgba(58,134,255,0.05))',
    transition: 'border 0.2s ease',
  } as const;

  return (
    <Box>
      <PageHeader title="Upload" breadcrumb={[{ label: 'Dashboard', to: '/' }, { label: 'Upload' }]} />
      <Paper
        component={motion.div}
        whileHover={{ scale: 1.03 }}
        whileTap={{ scale: 0.99 }}
        {...getRootProps()}
        sx={dropStyles}
      >
        <input {...getInputProps()} />
        <CloudUploadIcon sx={{ fontSize: 56, mb: 2 }} />
        <Typography variant="h6">
          {isDragActive
            ? 'Ablegen zum Hochladen'
            : file?.name ?? 'Datei hierher ziehen oder klicken ...'}
        </Typography>
      </Paper>
      <FormControl fullWidth sx={{ mb: 2 }}>
        <InputLabel id="prompt-label">Prompts</InputLabel>
        <Select
          labelId="prompt-label"
          multiple
          value={selected}
          onChange={e =>
            setSelected(
              typeof e.target.value === 'string' ? [] : (e.target.value as number[])
            )
          }
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
      <Button
        variant="contained"
        onClick={analyze}
        disabled={!file}
        component={motion.button}
        whileHover={{ y: -2 }}
      >
        Analyze
      </Button>
      {(uploadId || result) && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
          {uploadId && <Typography sx={{ mt: 2 }}>ID: {uploadId}</Typography>}
          {result && <Typography sx={{ mt: 1 }}>Result: {result}</Typography>}
        </motion.div>
      )}
    </Box>
  );
}
