import React, { useCallback, useState, useEffect } from 'react';
import { useDropzone } from 'react-dropzone';
import {
  Box, Typography, Paper, Button, IconButton,
} from '@mui/material';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import DeleteIcon from '@mui/icons-material/Delete';
import { DataGrid, GridColDef } from '@mui/x-data-grid';
import { motion } from 'framer-motion';
import PageHeader from '../components/PageHeader';

interface UploadEntry {
  id: number;
  status: string;
  pdfUrl: string;
  ocr: boolean;
}

export default function Upload() {
  const [file, setFile] = useState<File | null>(null);
  const [message, setMessage] = useState<string>('');
  const [entries, setEntries] = useState<UploadEntry[]>([]);

  const load = () => {
    Promise.all([
      fetch('http://localhost:8090/analyses').then(r => r.json()),
      fetch('http://localhost:8083/texts').then(r => r.json()),
    ])
      .then(([analysisData, texts]: [any[], { id: number }[]]) => {
        const ocrIds = texts.map(t => t.id);
        const mapped: UploadEntry[] = analysisData.map(d => ({
          id: d.pdf_id ?? d.pdfId,
          status: d.status,
          pdfUrl: d.pdf_url ?? d.pdfUrl,
          ocr: ocrIds.includes(d.pdf_id ?? d.pdfId),
        }));
        setEntries(mapped);
      })
      .catch(e => console.error('load uploads', e));
  };

  const onDrop = useCallback((files: File[]) => {
    console.log('Selected file', files[0]);
    setFile(files[0]);
  }, []);

  useEffect(load, []);

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
        load();
      })
      .catch(err => {
        console.error('Upload error', err);
        setMessage(`Error: ${(err as Error).message}`);
      });
  };

  const deletePdf = (id: number) => {
    const ingest = import.meta.env.VITE_INGEST_URL || 'http://localhost:8081';
    fetch(`${ingest}/pdf/${id}`, { method: 'DELETE' })
      .then(() => load())
      .catch(e => console.error('delete pdf', e));
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

  const columns: GridColDef[] = [
    { field: 'id', headerName: 'PDF', width: 90 },
    { field: 'status', headerName: 'Status', flex: 1 },
    { field: 'ocr', headerName: 'OCR', width: 80, valueGetter: p => (p.row.ocr ? 'Ja' : 'Nein') },
    {
      field: 'actions',
      headerName: '',
      sortable: false,
      width: 80,
      renderCell: params => (
        <IconButton size="small" onClick={() => deletePdf(params.row.id)}>
          <DeleteIcon fontSize="small" />
        </IconButton>
      ),
    },
  ];

  return (
    <Box>
      <PageHeader
        title="Upload"
        breadcrumb={[{ label: 'Dashboard', to: '/' }, { label: 'Upload' }]}
        actions={<Button variant="outlined" size="small" onClick={load}>Reload</Button>}
      />
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
      <Paper sx={{ mt: 3 }}>
        <DataGrid
          autoHeight
          disableRowSelectionOnClick
          rows={entries}
          columns={columns}
          pageSizeOptions={[5, 10, 25]}
          initialState={{ pagination: { paginationModel: { pageSize: 5, page: 0 } } }}
        />
      </Paper>
    </Box>
  );
}
