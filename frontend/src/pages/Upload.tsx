import React, { useCallback, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import {
  Box, Typography, Paper, Button,
} from '@mui/material';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import { motion } from 'framer-motion';
import PageHeader from '../components/PageHeader';

export default function Upload() {
  const [file, setFile] = useState<File | null>(null);
  const [message, setMessage] = useState<string>('');

  const onDrop = useCallback((files: File[]) => {
    console.log('Selected file', files[0]);
    setFile(files[0]);
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    multiple: false,
    accept: { 'application/pdf': ['.pdf'] },
  });

  const upload = () => {
    if (!file) return;
    console.log('Uploading file', file.name);
    const form = new FormData();
    form.append('file', file);
    const ingest = import.meta.env.VITE_INGEST_URL || 'http://localhost:8081';
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
        setMessage(`Upload erfolgreich. ID: ${d.id}`);
      })
      .catch(err => {
        console.error('Upload error', err);
        setMessage(`Error: ${(err as Error).message}`);
      });
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
      <Button
        variant="contained"
        onClick={upload}
        disabled={!file}
        component={motion.button}
        whileHover={{ y: -2 }}
        sx={{ mt: 2 }}
      >
        Upload
      </Button>
      {message && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
          <Typography sx={{ mt: 2 }}>{message}</Typography>
        </motion.div>
      )}
    </Box>
  );
}
