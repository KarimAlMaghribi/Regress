import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {useDropzone} from 'react-dropzone';
import {
  Alert,
  Box,
  Button,
  Chip,
  FormControl,
  Grid,
  IconButton,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Snackbar,
  Stack,
  Typography,
} from '@mui/material';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import DeleteIcon from '@mui/icons-material/Delete';
import {DataGrid, GridColDef} from '@mui/x-data-grid';
import {motion} from 'framer-motion';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CloseIcon from '@mui/icons-material/Close';
import CircularProgress from '@mui/material/CircularProgress';
import PageHeader from '../components/PageHeader';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import DownloadIcon from '@mui/icons-material/Download';
import RefreshIcon from '@mui/icons-material/Refresh';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import {useUploadStore} from '../hooks/useUploadStore';
import {UPLOAD_API} from '../utils/api';
import {usePipelineList} from '../hooks/usePipelineList';
import {useTenants} from '../hooks/useTenants';
import {alpha, useTheme} from '@mui/material/styles';

declare global {
  interface Window {
    __ENV__?: any
  }
}

export default function Upload() {
  const theme = useTheme();
  const [files, setFiles] = useState<File[]>([]);
  const [message, setMessage] = useState<string>('');
  const [snackOpen, setSnackOpen] = useState(false);

  const {pipelines} = usePipelineList();
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
  const {items: tenants, loading: tenantsLoading, error: tenantsError} = useTenants();
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

  const {getRootProps, getInputProps, isDragActive} = useDropzone({
    onDrop,
    multiple: true,
    accept: {'application/pdf': ['.pdf'], 'application/zip': ['.zip']},
  });

  const ingest = useMemo(() => UPLOAD_API, []);

  const upload = () => {
    if (!files.length || !tenantId) return;

    const form = new FormData();
    files.forEach(f => form.append('file', f));
    form.append('tenant_id', tenantId); // im Body

    // Zusätzlich: Header + Query-Param -> Backend kann tenant_id sofort verwenden
    const url = `${ingest.replace(/\/$/, '')}/upload?tenant_id=${encodeURIComponent(tenantId)}`;

    fetch(url, {
      method: 'POST',
      headers: {'X-Tenant-ID': tenantId},
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
    fetch(`${ingest.replace(/\/$/, '')}/pdf/${id}`, {method: 'DELETE'})
    .then(() => load().catch(() => {
    }))
    .catch(e => console.error('delete pdf', e));
  };

  const dropStyles = {
    p: {xs: 5, md: 6},
    border: `1px dashed ${alpha(theme.palette.primary.main, 0.35)}`,
    borderRadius: 'var(--radius-card)',
    textAlign: 'center' as const,
    cursor: 'pointer',
    background:
        theme.palette.mode === 'dark'
            ? alpha(theme.palette.primary.main, 0.08)
            : 'linear-gradient(135deg, rgba(0,110,199,0.08), rgba(0,110,199,0.03))',
    transition: 'border-color 0.2s ease, background 0.2s ease',
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing(1.5),
    alignItems: 'center',
    justifyContent: 'center',
  };

  const columns: GridColDef[] = [
    {
      field: 'open',
      headerName: 'Öffnen',
      width: 90,
      sortable: false,
      filterable: false,
      renderCell: (params) => params.row.pdfId ? (
          <IconButton
              size="small"
              component="a"
              href={`${UPLOAD_API.replace(/\/$/, '')}/pdf/${params.row.pdfId}`}
              target="_blank"
              rel="noopener noreferrer"
          >
            <OpenInNewIcon fontSize="small"/>
          </IconButton>
      ) : null,
    },
    {
      field: 'run',
      headerName: '',
      width: 60,
      sortable: false,
      renderCell: params => (
          <IconButton
              size="small"
              onClick={() => runPipeline(params.row.id, params.row.selectedPipelineId).catch(() => setSnackOpen(true))}
              disabled={!params.row.selectedPipelineId || params.row.loading}
          >
            {params.row.loading ? <CircularProgress size={16}/> : <PlayArrowIcon fontSize="small"/>}
          </IconButton>
      ),
    },
    {
      field: 'download',
      headerName: '',
      width: 60,
      sortable: false,
      renderCell: params => (
          <IconButton size="small" onClick={() => useUploadStore.downloadExtractedText(params.row.id)}
                      disabled={!params.row.ocr}>
            <DownloadIcon fontSize="small"/>
          </IconButton>
      ),
    },
    {
      field: 'ocr',
      headerName: 'OCR',
      width: 80,
      renderCell: params => {
        const st = params.row.status as string;
        if (st === 'ocr' || st === 'merging') return <CircularProgress size={16}/>;
        if (st === 'ready' && params.row.ocr) return <CheckCircleIcon color="success"
                                                                      fontSize="small"/>;
        return <CloseIcon color="error" fontSize="small"/>;
      },
    },
    {
      field: 'layout',
      headerName: 'Layout',
      width: 80,
      renderCell: params => {
        const st = params.row.status as string;
        if (st !== 'ready') return <CircularProgress size={16}/>;
        return <CheckCircleIcon color="success" fontSize="small"/>;
      },
    },
    {
      field: 'actions',
      headerName: '',
      sortable: false,
      width: 80,
      renderCell: params => (
          <IconButton size="small" onClick={() => deletePdf(params.row.pdfId)}
                      disabled={!params.row.pdfId}>
            <DeleteIcon fontSize="small"/>
          </IconButton>
      ),
    },
  ];

  const uploadDisabled = !files.length || !tenantId;
  const isErrorMessage = message.toLowerCase().startsWith('error');

  return (
      <Stack spacing={4}>
        <PageHeader
            title="Upload"
            subtitle="Dokumente mandantenbezogen bereitstellen und zur Pipeline weiterleiten"
            breadcrumb={[{label: 'Dashboard', to: '/'}, {label: 'Upload'}]}
            tone="primary"
            icon={<CloudUploadIcon/>}
            tag={`Aktive Einträge: ${entries.length}`}
            actions={
              <Button
                  variant="outlined"
                  size="small"
                  startIcon={<RefreshIcon/>}
                  onClick={() => load().catch(() => setSnackOpen(true))}
              >
                Aktualisieren
              </Button>
            }
        />

        <Grid container spacing={3}>
          <Grid item xs={12} md={5}>
            <Paper
                variant="outlined"
                sx={{
                  p: {xs: 3, md: 4},
                  borderRadius: 'var(--radius-card)',
                  boxShadow: 'var(--shadow-z1)',
                  background:
                      theme.palette.mode === 'dark'
                          ? alpha(theme.palette.primary.main, 0.08)
                          : 'linear-gradient(135deg, rgba(0,110,199,0.08), rgba(247,250,252,0.9))',
                }}
            >
              <Stack spacing={2.5}>
                <Box>
                  <Typography variant="h6" sx={{fontWeight: 600}}>
                    Upload-Übersicht
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Wähle zuerst den passenden Mandanten aus und lade anschließend PDF- oder
                    ZIP-Dateien hoch.
                    Die Dateien werden automatisch der gewählten Pipeline zugeordnet.
                  </Typography>
                </Box>
                <Stack direction="row" spacing={1} flexWrap="wrap">
                  <Chip label={`Dateien ausgewählt: ${files.length}`}
                        color={files.length ? 'primary' : 'default'}/>
                  <Chip label={`Pipelines: ${pipelines.length}`} variant="outlined"/>
                </Stack>
              </Stack>
            </Paper>
          </Grid>
          <Grid item xs={12} md={7}>
            <Paper
                variant="outlined"
                sx={{
                  p: {xs: 3, md: 4},
                  borderRadius: 'var(--radius-card)',
                  boxShadow: 'var(--shadow-z1)',
                }}
            >
              <Stack spacing={3}>
                <Stack spacing={1}>
                  <Typography variant="subtitle1" sx={{fontWeight: 600}}>
                    Mandant und Upload vorbereiten
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Mandant festlegen und Dateien im nächsten Schritt hinzufügen.
                  </Typography>
                </Stack>

                <Stack direction={{xs: 'column', sm: 'row'}} spacing={2.5}
                       alignItems={{sm: 'center'}}>
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
                  <Typography variant="body2" color="text.secondary" sx={{minWidth: {sm: 180}}}>
                    Pflichtschritt vor dem Upload.
                  </Typography>
                </Stack>

                {tenantsError && (
                    <Alert severity="error">{tenantsError}</Alert>
                )}

                <Box
                    component={motion.div}
                    whileHover={{scale: 1.01}}
                    whileTap={{scale: 0.995}}
                    {...getRootProps()}
                    sx={dropStyles}
                >
                  <input {...getInputProps()} />
                  <CloudUploadIcon sx={{fontSize: 48, color: theme.palette.primary.main}}/>
                  <Typography variant="h6" sx={{fontWeight: 600}}>
                    {isDragActive
                        ? 'Ablegen zum Hochladen'
                        : files.length
                            ? files.map(f => f.name).join(', ')
                            : 'Datei hierher ziehen oder klicken'}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Unterstützt werden PDF und ZIP. Mehrere Dateien sind möglich.
                  </Typography>
                </Box>

                <Stack direction={{xs: 'column', sm: 'row'}} spacing={2}
                       alignItems={{sm: 'center'}}>
                  <Button
                      variant="contained"
                      onClick={upload}
                      disabled={uploadDisabled}
                      component={motion.button}
                      whileHover={{y: -2}}
                      sx={{alignSelf: {xs: 'stretch', sm: 'flex-start'}}}
                  >
                    Upload starten
                  </Button>
                  {message && (
                      <motion.div initial={{opacity: 0}} animate={{opacity: 1}}>
                        <Alert severity={isErrorMessage ? 'error' : 'success'}>{message}</Alert>
                      </motion.div>
                  )}
                </Stack>
              </Stack>
            </Paper>
          </Grid>
        </Grid>

        <Paper
            variant="outlined"
            sx={{
              p: {xs: 2, md: 3},
              borderRadius: 'var(--radius-card)',
              boxShadow: 'var(--shadow-z1)',
            }}
        >
          <Stack spacing={2.5}>
            <Stack direction="row" alignItems="center" justifyContent="space-between"
                   flexWrap="wrap" gap={1.5}>
              <Typography variant="h6" sx={{fontWeight: 600}}>
                Eingehende Dokumente
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Pipeline je Datei festlegen und Verarbeitung starten.
              </Typography>
            </Stack>
            <DataGrid
                autoHeight
                disableRowSelectionOnClick
                rows={entries}
                columns={columns}
                pageSizeOptions={[5, 10, 25]}
                initialState={{pagination: {paginationModel: {pageSize: 5, page: 0}}}}
            />
          </Stack>
        </Paper>

        <Snackbar open={snackOpen} autoHideDuration={6000} onClose={() => setSnackOpen(false)}>
          <Alert onClose={() => setSnackOpen(false)} severity="error" sx={{width: '100%'}}>
            Statusaktualisierung fehlgeschlagen, versuche es erneut.
          </Alert>
        </Snackbar>
      </Stack>
  );
}
