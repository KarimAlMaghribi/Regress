import React, { useCallback, useState, useEffect, useMemo } from 'react';
import { useDropzone } from 'react-dropzone';
import {
  Box, Typography, Paper, Button, IconButton, Select, MenuItem,
  FormControl, InputLabel, Snackbar, Alert, Stack
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
import { useTenants } from '../hooks/useTenants';

declare global { interface Window { __ENV__?: any } }

export default function Upload() {
  const [files, setFiles] = useState<File[]>([]);
  const [message, setMessage] = useState<string>('');
  const [pipelineId, setPipelineId] = useState('');
  const [snackOpen, setSnackOpen] = useState(false);

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

  // TENANTS
  const { items: tenants, loading: tenantsLoading, error: tenantsError } = useTenants();
  const [tenantId, setTenantId] = useState<string>('');

  const onDrop = useCallback((sel: File[]) => {
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

  const ingest = useMemo(() => {
    const runtimeIngest =
      typeof window !== 'undefined'
        ? ((window as unknown as { __ENV__?: { INGEST_URL?: string } }).__ENV__?.INGEST_URL ?? undefined)
        : undefined;
    return (
      (runtimeIngest as string | undefined) ||
      (import.meta.env.VITE_INGEST_URL as string | undefined) ||
      'http://localhost:8081'
    );
  }, []);

  const upload = () => {
    if (!files.length || !tenantId) return;

    const form = new FormData();
    files.forEach(f => form.append('file', f));
    if (pipelineId) form.append('pipeline_id', pipelineId);
    form.append('tenant_id', tenantId); // im Body

    // Zusätzlich: Header + Query-Param -> Backend kann tenant_id sofort verwenden
    const url = `${ingest.replace(/\/$/, '')}/upload?tenant_id=${encodeURIComponent(tenantId)}`;

    fetch(url, {
      method: 'POST',
      headers: { 'X-Tenant-ID': tenantId },
      body: form,
    })
    .then(async r => {
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        throw new Error(text || `HTTP ${r.status}`);
      }
      return r.json();
    })
    .then(d => {
      setMessage(`Upload erfolgreich. ID: ${d.id ?? ''}`.trim());
      setFiles([]);
      load();
    })
    .catch(err => {
      setMessage(`Error: ${(err as Error).message}`);
    });
  };

  const deletePdf = (id: number) => {
    fetch(`${ingest.replace(/\/$/, '')}/pdf/${id}`, { method: 'DELETE' })
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

  const uploadDisabled = !files.length || !tenantId;

  return (
      <Box>
        <PageHeader
            title="Upload"
            breadcrumb={[{ label: 'Dashboard', to: '/' }, { label: 'Upload' }]}
            actions={<Button variant="outlined" size="small" onClick={()=>load().catch(()=>{})}>Reload</Button>}
        />

        {/* Tenant-Auswahl */}
        <Paper sx={{ p: 2, mb: 2 }}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems="center">
            <FormControl fullWidth>
              <InputLabel id="tenant-label">Mandant</InputLabel>
              <Select
                  labelId="tenant-label"
                  label="Mandant"
                  value={tenantId}
                  onChange={(e) => setTenantId(String(e.target.value))}
                  disabled={tenantsLoading}
              >
                {tenants.map(t => (
                    <MenuItem key={t.id} value={t.id}>{t.name}</MenuItem>
                ))}
              </Select>
            </FormControl>
            <Typography variant="body2" color="text.secondary">
              Bitte vor dem Upload Mandant auswählen.
            </Typography>
          </Stack>
          {tenantsError && (
              <Alert severity="error" sx={{ mt: 2 }}>
                {tenantsError}
              </Alert>
          )}
        </Paper>

        {/* Dropzone */}
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

        {/* Upload-Button */}
        <Button
            variant="contained"
            onClick={upload}
            disabled={uploadDisabled}
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

        {/* Tabelle */}
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
