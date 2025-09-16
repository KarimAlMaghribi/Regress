import React, { useCallback, useState, useEffect } from 'react';
import { useDropzone } from 'react-dropzone';
import {
  Box, Typography, Paper, Button, IconButton, Select, MenuItem,
  FormControl, InputLabel, Snackbar, Alert,
} from '@mui/material';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import DeleteIcon from '@mui/icons-material/Delete';
import { DataGrid, GridColDef } from '@mui/x-data-grid';
import { motion } from 'framer-motion';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CloseIcon from '@mui/icons-material/Close';
import CircularProgress from '@mui/material/CircularProgress';
import PageHeader from '../components/PageHeader';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import DownloadIcon from '@mui/icons-material/Download';
import { useUploadStore } from '../hooks/useUploadStore';
import { usePipelineList } from '../hooks/usePipelineList';

export default function Upload() {
  const [files, setFiles] = useState<File[]>([]);
  const [message, setMessage] = useState<string>('');
  const [pipelineId, setPipelineId] = useState('');

  const { pipelines } = usePipelineList();
  const {
    entries,
    load,
    updateFile,
    runPipeline,
    downloadExtractedText,
    startAutoRefresh,
    stopAutoRefresh,
    error,
  } = useUploadStore();
  const [snackOpen, setSnackOpen] = useState(false);

  const onDrop = useCallback((sel: File[]) => {
    console.log('Selected files', sel);
    setFiles(sel);
  }, []);

  useEffect(() => {
    load()
      .then(() => startAutoRefresh(3000))
      .catch(() => setSnackOpen(true));
    return () => stopAutoRefresh();
  }, [load, startAutoRefresh, stopAutoRefresh]);

  useEffect(() => {
    if (error) setSnackOpen(true);
  }, [error]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    multiple: true,
    accept: { 'application/pdf': ['.pdf'], 'application/zip': ['.zip'] },
  });

  const upload = () => {
    if (!files.length) return;
    console.log('Uploading files', files.map(f => f.name));
    const form = new FormData();
    files.forEach(f => form.append('file', f));
    if (pipelineId) form.append('pipeline_id', pipelineId);
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
        setFiles([]);
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
      .then(() => load().catch(()=>{}))
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
    { field: 'pdfId', headerName: 'PDF', width: 90 },
    { field: 'status', headerName: 'Status', flex: 1 },
    {
      field: 'pipeline',
      headerName: 'Pipeline',
      width: 180,
      renderCell: params => (
        <Select
          size="small"
          fullWidth
          value={params.row.selectedPipelineId || ''}
          onChange={e => updateFile(params.row.id, { selectedPipelineId: e.target.value })}
        >
          {pipelines.map(p => (
            <MenuItem key={p.id} value={p.id}>{p.name}</MenuItem>
          ))}
        </Select>
      ),
    },
    {
      field: 'run',
      headerName: '',
      width: 60,
      sortable: false,
      renderCell: params => (
        <IconButton
          size="small"
          onClick={() => runPipeline(params.row.id, params.row.selectedPipelineId).catch(()=>setSnackOpen(true))}
          disabled={!params.row.selectedPipelineId || params.row.loading}
        >
          {params.row.loading ? <CircularProgress size={16} /> : <PlayArrowIcon fontSize="small" />}
        </IconButton>
      ),
    },
    {
      field: 'download',
      headerName: '',
      width: 60,
      sortable: false,
      renderCell: params => (
        <IconButton size="small" onClick={() => downloadExtractedText(params.row.id)} disabled={!params.row.ocr}>
          <DownloadIcon fontSize="small" />
        </IconButton>
      ),
    },
    {
      field: 'ocr',
      headerName: 'OCR',
      width: 80,
      renderCell: params => {
        const st = params.row.status as string;
        if (st === 'ocr' || st === 'merging') return <CircularProgress size={16} />;
        if (st === 'ready' && params.row.ocr) return <CheckCircleIcon color="success" fontSize="small" />;
        return <CloseIcon color="error" fontSize="small" />;
      },
    },
    {
      field: 'layout',
      headerName: 'Layout',
      width: 80,
      renderCell: params => {
        const st = params.row.status as string;
        if (st !== 'ready') return <CircularProgress size={16} />;
        return <CheckCircleIcon color="success" fontSize="small" />;
      },
    },
    {
      field: 'actions',
      headerName: '',
      sortable: false,
      width: 80,
      renderCell: params => (
        <IconButton size="small" onClick={() => deletePdf(params.row.pdfId)} disabled={!params.row.pdfId}>
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
        actions={<Button variant="outlined" size="small" onClick={()=>load().catch(()=>{})}>Reload</Button>}
      />
      <FormControl sx={{ mt:2, mb:2, minWidth:200 }}>
        <InputLabel>Pipeline</InputLabel>
        <Select label="Pipeline" value={pipelineId} onChange={e=>setPipelineId(e.target.value)} disabled={pipelines.length===0}>
          {pipelines.map(p=> (
            <MenuItem key={p.id} value={p.id}>{p.name}</MenuItem>
          ))}
        </Select>
      </FormControl>
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
            : files.length
            ? files.map(f => f.name).join(', ')
            : 'Datei hierher ziehen oder klicken ...'}
        </Typography>
      </Paper>
      <Button
        variant="contained"
        onClick={upload}
        disabled={!files.length}
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
      <Snackbar open={snackOpen} autoHideDuration={6000} onClose={() => setSnackOpen(false)}>
        <Alert onClose={() => setSnackOpen(false)} severity="error" sx={{ width: '100%' }}>
          Statusaktualisierung fehlgeschlagen, versuche erneut
        </Alert>
      </Snackbar>
    </Box>
  );
}
