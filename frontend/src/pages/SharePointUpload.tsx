import React from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  CircularProgress,
  Chip,
  FormControl,
  InputLabel,
  LinearProgress,
  MenuItem,
  Paper,
  Select,
  SelectChangeEvent,
  Stack,
  Tab,
  Tabs,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import PauseIcon from '@mui/icons-material/Pause';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import ReplayIcon from '@mui/icons-material/Replay';
import StopIcon from '@mui/icons-material/Stop';
import PageHeader from '../components/PageHeader';
import {
  INGEST_POLL_INTERVAL,
  createJobs,
  fetchFolders,
  fetchJobs,
  triggerJobAction,
} from '../utils/ingestApi';
import type {
  FolderSummary,
  JobOrder,
  JobStatus,
  JobSummary,
  UploadListEntry,
} from '../types/ingest';
import axios from 'axios';
import {useTenants} from '../hooks/useTenants';
import {usePipelineList} from '../hooks/usePipelineList';
import {API_BASE, INGEST_API} from '../utils/api';

const statusChipColor: Record<JobStatus, 'default' | 'primary' | 'secondary' | 'error' | 'info' | 'success' | 'warning'> = {
  queued: 'info',
  running: 'primary',
  paused: 'warning',
  succeeded: 'success',
  failed: 'error',
  canceled: 'default',
};

const jobActionMessages: Record<'pause' | 'resume' | 'cancel' | 'retry', string> = {
  pause: 'Job pausiert.',
  resume: 'Job fortgesetzt.',
  cancel: 'Job beendet.',
  retry: 'Job erneut gestartet.',
};

function getErrorMessage(error: unknown) {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    if (status === 401 || status === 403) {
      return 'Kein Zugriff';
    }
    const data = error.response?.data as { message?: string } | string | undefined;
    if (typeof data === 'string' && data.trim().length > 0) {
      return data;
    }
    if (data && typeof data === 'object' && 'message' in data && data.message) {
      return data.message;
    }
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'Unbekannter Fehler';
}

function parseNumericId(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = Number.parseInt(trimmed, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function extractPdfId(job: JobSummary): number | null {
  const direct = parseNumericId(job.pdf_id);
  if (direct != null) {
    return direct;
  }
  const output = job.output;
  if (output) {
    const nested = parseNumericId(output.pdf_id);
    if (nested != null) {
      return nested;
    }
    const response = output.response as Record<string, unknown> | undefined;
    if (response && typeof response === 'object') {
      const candidate =
        (response as { [key: string]: unknown }).pdf_id ??
        (response as { [key: string]: unknown }).pdfId ??
        (response as { [key: string]: unknown }).id;
      const parsed = parseNumericId(candidate);
      if (parsed != null) {
        return parsed;
      }
    }
  }
  return null;
}

function extractUploadId(job: JobSummary): number | null {
  const direct = parseNumericId(job.upload_id);
  if (direct != null) {
    return direct;
  }
  const output = job.output;
  if (output) {
    const nested = parseNumericId(output.upload_id);
    if (nested != null) {
      return nested;
    }
    const response = output.response as Record<string, unknown> | undefined;
    if (response && typeof response === 'object') {
      const candidate =
        (response as { [key: string]: unknown }).upload_id ??
        (response as { [key: string]: unknown }).uploadId;
      const parsed = parseNumericId(candidate);
      if (parsed != null) {
        return parsed;
      }
    }
  }
  return null;
}

interface TabPanelProps {
  children?: React.ReactNode;
  index: number;
  value: number;
}

function TabPanel({ children, value, index }: TabPanelProps) {
  return (
    <div role="tabpanel" hidden={value !== index}>
      {value === index && <Box sx={{ pt: 3 }}>{children}</Box>}
    </div>
  );
}

export default function SharePointUpload() {
  const [tab, setTab] = React.useState(0);
  const [folders, setFolders] = React.useState<FolderSummary[]>([]);
  const [folderMeta, setFolderMeta] = React.useState<{ base: string; total: number } | null>(null);
  const [selectedFolders, setSelectedFolders] = React.useState<string[]>([]);
  const [folderError, setFolderError] = React.useState<string | null>(null);
  const [foldersLoading, setFoldersLoading] = React.useState(false);
  const [creatingJobs, setCreatingJobs] = React.useState(false);
  const [order, setOrder] = React.useState<JobOrder>('alpha');
  const [jobs, setJobs] = React.useState<JobSummary[]>([]);
  const [jobsLoading, setJobsLoading] = React.useState(false);
  const [jobError, setJobError] = React.useState<string | null>(null);
  const [actioningJobId, setActioningJobId] = React.useState<string | null>(null);
  const [successMessage, setSuccessMessage] = React.useState<string | null>(null);
  const { items: tenants, loading: tenantsLoading, error: tenantsError } = useTenants();
  const [tenantId, setTenantId] = React.useState<string>('');
  const { pipelines } = usePipelineList();
  const uploadBase = React.useMemo(() => INGEST_API.replace(/\/$/, ''), []);
  const pipelineApiBase = React.useMemo(() => API_BASE.replace(/\/$/, ''), []);
  const [uploadsByPdfId, setUploadsByPdfId] = React.useState<Map<number, UploadListEntry>>(
    () => new Map(),
  );
  const [uploadsById, setUploadsById] = React.useState<Map<number, UploadListEntry>>(
    () => new Map(),
  );
  const [pipelineSelections, setPipelineSelections] = React.useState<Record<string, string>>({});
  const [pipelineError, setPipelineError] = React.useState<string | null>(null);
  const [pipelineRunningJobId, setPipelineRunningJobId] = React.useState<string | null>(null);
  const tenantNameMap = React.useMemo(() => {
    const map = new Map<string, string>();
    tenants.forEach((tenant) => map.set(tenant.id, tenant.name));
    return map;
  }, [tenants]);

  React.useEffect(() => {
    if (!tenantId && tenants.length === 1) {
      setTenantId(tenants[0].id);
    } else if (tenantId && tenants.every((tenant) => tenant.id !== tenantId)) {
      setTenantId('');
    }
  }, [tenantId, tenants]);

  const loadFolders = React.useCallback(async () => {
    setFoldersLoading(true);
    setFolderError(null);
    try {
      const data = await fetchFolders();
      setFolders(data.items);
      setFolderMeta({ base: data.base, total: data.total });
    } catch (error) {
      setFolderError(getErrorMessage(error));
      setFolders([]);
      setFolderMeta(null);
    } finally {
      setFoldersLoading(false);
    }
  }, []);

  const refreshUploads = React.useCallback(
    async (jobList: JobSummary[]) => {
      const pdfIds = new Set<number>();
      const uploadIds = new Set<number>();
      jobList.forEach((job) => {
        const pdfId = extractPdfId(job);
        if (pdfId != null) {
          pdfIds.add(pdfId);
        }
        const uploadId = extractUploadId(job);
        if (uploadId != null) {
          uploadIds.add(uploadId);
        }
      });
      if (pdfIds.size === 0 && uploadIds.size === 0) {
        setUploadsByPdfId(new Map());
        setUploadsById(new Map());
        setPipelineError(null);
        return;
      }
      try {
        const { data } = await axios.get<UploadListEntry[]>(`${uploadBase}/uploads`);
        const byPdf = new Map<number, UploadListEntry>();
        const byId = new Map<number, UploadListEntry>();
        data.forEach((entry) => {
          const matchesPdf = entry.pdf_id != null && pdfIds.has(entry.pdf_id);
          const matchesUpload = uploadIds.has(entry.id);
          if (!matchesPdf && !matchesUpload) {
            return;
          }
          if (entry.pdf_id != null) {
            byPdf.set(entry.pdf_id, entry);
          }
          byId.set(entry.id, entry);
        });
        setUploadsByPdfId(byPdf);
        setUploadsById(byId);
        setPipelineError(null);
      } catch (error) {
        setPipelineError(getErrorMessage(error));
      }
    },
    [uploadBase],
  );

  const loadJobs = React.useCallback(
    async (options?: { silent?: boolean }) => {
      const silent = options?.silent ?? false;
      if (!silent) {
        setJobsLoading(true);
      }
      try {
        const data = await fetchJobs();
        setJobs(data.jobs);
        setJobError(null);
        await refreshUploads(data.jobs);
      } catch (error) {
        setJobError(getErrorMessage(error));
        setJobs([]);
        setUploadsByPdfId(new Map());
        setUploadsById(new Map());
      } finally {
        if (!silent) {
          setJobsLoading(false);
        }
      }
    },
    [refreshUploads],
  );

  React.useEffect(() => {
    loadFolders();
  }, [loadFolders]);

  React.useEffect(() => {
    if (tab !== 1) {
      return undefined;
    }

    let cancelled = false;

    const loadInitial = async () => {
      await loadJobs();
    };

    loadInitial();

    const intervalId = window.setInterval(() => {
      if (!cancelled) {
        loadJobs({ silent: true });
      }
    }, INGEST_POLL_INTERVAL);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [tab, loadJobs]);

  React.useEffect(() => {
    setPipelineSelections((prev) => {
      const next: Record<string, string> = {};
      jobs.forEach((job) => {
        if (Object.prototype.hasOwnProperty.call(prev, job.id)) {
          next[job.id] = prev[job.id];
        }
      });
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
  }, [jobs]);

  const allSelected = folders.length > 0 && selectedFolders.length === folders.length;
  const isIndeterminate = selectedFolders.length > 0 && !allSelected;

  const handleToggleFolder = (id: string) => {
    setSelectedFolders((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
    );
  };

  const handleSelectAll = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.checked) {
      setSelectedFolders(folders.map((folder) => folder.id));
    } else {
      setSelectedFolders([]);
    }
  };

  const handleChangeOrder = (event: SelectChangeEvent<JobOrder>) => {
    setOrder(event.target.value as JobOrder);
  };

  const startJobs = async () => {
    if (!tenantId) {
      setFolderError('Bitte wähle einen Mandanten aus, bevor Jobs gestartet werden.');
      return;
    }
    setCreatingJobs(true);
    setSuccessMessage(null);
    setPipelineError(null);
    try {
      setFolderError(null);
      const uploadUrl = `${uploadBase}/upload?tenant_id=${encodeURIComponent(tenantId)}`;
      await createJobs({
        folder_ids: selectedFolders,
        order,
        tenant_id: tenantId,
        upload_url: uploadUrl,
      });
      setSuccessMessage('Jobs erfolgreich gestartet.');
      setSelectedFolders([]);
      setTab(1);
      await loadJobs();
    } catch (error) {
      setFolderError(getErrorMessage(error));
    } finally {
      setCreatingJobs(false);
    }
  };

  const handleJobAction = async (jobId: string, action: 'pause' | 'resume' | 'cancel' | 'retry') => {
    setActioningJobId(jobId);
    setSuccessMessage(null);
    try {
      await triggerJobAction(jobId, action);
      setSuccessMessage(jobActionMessages[action]);
      await loadJobs();
    } catch (error) {
      setJobError(getErrorMessage(error));
    } finally {
      setActioningJobId(null);
    }
  };

  const handlePipelineSelectionChange = React.useCallback((jobId: string, value: string) => {
    setPipelineSelections((prev) => ({ ...prev, [jobId]: value }));
  }, []);

  const handleRunPipeline = React.useCallback(
    async (job: JobSummary) => {
      if (pipelines.length === 0) {
        setPipelineError('Keine Pipeline konfiguriert.');
        return;
      }
      if (job.status !== 'succeeded') {
        setPipelineError('Der Job ist noch nicht abgeschlossen.');
        return;
      }
      const defaultPipelineId = pipelines.length === 1 ? pipelines[0].id : '';
      const selection = pipelineSelections[job.id] ?? defaultPipelineId;
      if (!selection) {
        setPipelineError('Bitte wähle eine Pipeline für diesen Job.');
        return;
      }
      const pdfId = extractPdfId(job);
      const uploadIdFromJob = extractUploadId(job);
      const uploadFromPdf = pdfId != null ? uploadsByPdfId.get(pdfId) : undefined;
      const uploadFromId = uploadIdFromJob != null ? uploadsById.get(uploadIdFromJob) : undefined;
      const resolvedUploadId =
        uploadIdFromJob ?? uploadFromPdf?.id ?? uploadFromId?.id ?? null;
      if (resolvedUploadId == null) {
        setPipelineError('Upload-ID für diesen Job wurde noch nicht ermittelt.');
        return;
      }
      setPipelineRunningJobId(job.id);
      setSuccessMessage(null);
      setPipelineError(null);
      try {
        await axios.post(`${pipelineApiBase}/pipelines/${selection}/run`, {
          file_id: resolvedUploadId,
        });
        const pipelineName = pipelines.find((pipeline) => pipeline.id === selection)?.name ?? selection;
        setSuccessMessage(`Pipeline „${pipelineName}“ für Upload ${resolvedUploadId} gestartet.`);
        await loadJobs({ silent: true });
      } catch (error) {
        setPipelineError(getErrorMessage(error));
      } finally {
        setPipelineRunningJobId(null);
      }
    },
    [pipelineSelections, pipelines, uploadsByPdfId, uploadsById, pipelineApiBase, loadJobs],
  );

  const renderFoldersTable = () => {
    if (foldersLoading) {
      return (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
          <CircularProgress />
        </Box>
      );
    }

    if (folders.length === 0) {
      return (
        <Box sx={{ py: 6, textAlign: 'center' }}>
          <Typography variant="body2" color="text.secondary">
            Keine Einträge
          </Typography>
        </Box>
      );
    }

    return (
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell padding="checkbox">
              <Checkbox
                indeterminate={isIndeterminate}
                checked={allSelected}
                onChange={handleSelectAll}
                inputProps={{ 'aria-label': 'alle Anlagen auswählen' }}
              />
            </TableCell>
            <TableCell>Ordnername</TableCell>
            <TableCell align="right">Dateien gesamt</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {folders.map((folder) => {
            const checked = selectedFolders.includes(folder.id);
            return (
              <TableRow key={folder.id} hover selected={checked}>
                <TableCell padding="checkbox">
                  <Checkbox
                    checked={checked}
                    onChange={() => handleToggleFolder(folder.id)}
                    inputProps={{ 'aria-label': `${folder.name} auswählen` }}
                  />
                </TableCell>
                <TableCell>{folder.name}</TableCell>
                <TableCell align="right">{folder.file_count}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    );
  };

  const renderJobsTable = () => {
    if (jobsLoading && jobs.length === 0) {
      return (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
          <CircularProgress />
        </Box>
      );
    }

    if (!jobsLoading && jobs.length === 0) {
      return (
        <Box sx={{ py: 6, textAlign: 'center' }}>
          <Typography variant="body2" color="text.secondary">
            Keine Einträge
          </Typography>
        </Box>
      );
    }

    return (
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>Ordner</TableCell>
            <TableCell>Mandant</TableCell>
            <TableCell>PDF</TableCell>
            <TableCell>Pipeline-Lauf</TableCell>
            <TableCell>Status</TableCell>
            <TableCell>Fortschritt</TableCell>
            <TableCell>Nachricht</TableCell>
            <TableCell align="right">Aktionen</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {jobs.map((job) => {
            const percent = Math.round(Math.min(Math.max(job.progress ?? 0, 0), 1) * 100);
            const isActioning = actioningJobId === job.id;
            const disableCancel = ['canceled', 'failed', 'succeeded'].includes(job.status);
            const tenantLabel =
              job.tenant_id && typeof job.tenant_id === 'string'
                ? tenantNameMap.get(job.tenant_id) ?? job.tenant_id
                : null;
            const defaultPipelineId = pipelines.length === 1 ? pipelines[0].id : '';
            const selection = pipelineSelections[job.id] ?? defaultPipelineId;
            const pdfId = extractPdfId(job);
            const uploadIdFromJob = extractUploadId(job);
            const uploadFromPdf = pdfId != null ? uploadsByPdfId.get(pdfId) : undefined;
            const uploadFromId = uploadIdFromJob != null ? uploadsById.get(uploadIdFromJob) : undefined;
            const resolvedUploadId =
              uploadIdFromJob ?? uploadFromPdf?.id ?? uploadFromId?.id ?? null;
            const uploadStatus = uploadFromPdf?.status ?? uploadFromId?.status;
            const isRunningPipeline = pipelineRunningJobId === job.id;
            const pipelineSelectDisabled = pipelines.length === 0 || job.status !== 'succeeded';
            const canRunPipeline =
              job.status === 'succeeded' &&
              !!selection &&
              resolvedUploadId != null &&
              pipelines.length > 0 &&
              !isRunningPipeline;
            let helperText: string | null = null;
            if (pipelines.length === 0) {
              helperText = 'Keine Pipelines konfiguriert.';
            } else if (job.status !== 'succeeded') {
              helperText = 'Pipeline-Lauf verfügbar nach Abschluss des Jobs.';
            } else if (resolvedUploadId == null) {
              helperText = 'Upload wird ermittelt…';
            } else if (!selection) {
              helperText = 'Bitte Pipeline wählen.';
            } else if (uploadStatus) {
              helperText = `Upload-Status: ${uploadStatus}`;
            } else if (job.pipeline_id && typeof job.pipeline_id === 'string') {
              const name = pipelines.find((pipeline) => pipeline.id === job.pipeline_id)?.name ?? job.pipeline_id;
              helperText = `Zuletzt ausgewählt: ${name}`;
            }
            return (
              <TableRow key={job.id} hover>
                <TableCell>{job.folder_name}</TableCell>
                <TableCell>
                  {tenantLabel ? (
                    <Chip label={tenantLabel} size="small" />
                  ) : (
                    <Typography variant="body2" color="text.secondary">
                      —
                    </Typography>
                  )}
                </TableCell>
                <TableCell sx={{ minWidth: 180 }}>
                  {pdfId != null || resolvedUploadId != null ? (
                    <Stack spacing={0.5}>
                      {pdfId != null && (
                        <Typography variant="body2">PDF #{pdfId}</Typography>
                      )}
                      {resolvedUploadId != null ? (
                        <Typography variant="caption" color="text.secondary">
                          Upload-ID {resolvedUploadId}
                          {uploadStatus ? ` • Status: ${uploadStatus}` : ''}
                        </Typography>
                      ) : (
                        <Typography variant="caption" color="text.secondary">
                          {job.status === 'succeeded'
                            ? 'Upload wird ermittelt…'
                            : 'Upload in Vorbereitung…'}
                        </Typography>
                      )}
                    </Stack>
                  ) : (
                    <Typography variant="body2" color="text.secondary">—</Typography>
                  )}
                </TableCell>
                <TableCell sx={{ minWidth: 260 }}>
                  <Stack spacing={1}>
                    <FormControl size="small" fullWidth disabled={pipelineSelectDisabled}>
                      <Select
                        size="small"
                        value={selection}
                        onChange={(event) =>
                          handlePipelineSelectionChange(job.id, event.target.value as string)
                        }
                        displayEmpty
                      >
                        <MenuItem value="">
                          <em>Pipeline wählen</em>
                        </MenuItem>
                        {pipelines.map((pipeline) => (
                          <MenuItem key={pipeline.id} value={pipeline.id}>
                            {pipeline.name}
                          </MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                    <Button
                      size="small"
                      variant="contained"
                      startIcon={
                        isRunningPipeline ? (
                          <CircularProgress size={16} color="inherit" />
                        ) : (
                          <PlayArrowIcon fontSize="small" />
                        )
                      }
                      onClick={() => handleRunPipeline(job)}
                      disabled={!canRunPipeline}
                    >
                      {isRunningPipeline ? 'Startet…' : 'Pipeline starten'}
                    </Button>
                    {helperText && (
                      <Typography variant="caption" color="text.secondary">
                        {helperText}
                      </Typography>
                    )}
                  </Stack>
                </TableCell>
                <TableCell>
                  <Chip label={job.status} size="small" color={statusChipColor[job.status]} />
                </TableCell>
                <TableCell>
                  <Stack spacing={1}>
                    <LinearProgress variant="determinate" value={percent} />
                    <Typography variant="caption" color="text.secondary">
                      {percent}%
                    </Typography>
                  </Stack>
                </TableCell>
                <TableCell sx={{ maxWidth: 280 }}>
                  <Typography variant="body2" noWrap title={job.message ?? ''}>
                    {job.message || '—'}
                  </Typography>
                </TableCell>
                <TableCell align="right">
                  <Stack direction="row" spacing={1} justifyContent="flex-end">
                    <Button
                      size="small"
                      variant="outlined"
                      startIcon={<PauseIcon fontSize="small" />}
                      onClick={() => handleJobAction(job.id, 'pause')}
                      disabled={job.status !== 'running' || isActioning}
                    >
                      Pause
                    </Button>
                    <Button
                      size="small"
                      variant="outlined"
                      startIcon={<PlayArrowIcon fontSize="small" />}
                      onClick={() => handleJobAction(job.id, 'resume')}
                      disabled={job.status !== 'paused' || isActioning}
                    >
                      Fortsetzen
                    </Button>
                    <Button
                      size="small"
                      variant="outlined"
                      color="error"
                      startIcon={<StopIcon fontSize="small" />}
                      onClick={() => handleJobAction(job.id, 'cancel')}
                      disabled={disableCancel || isActioning}
                    >
                      Beenden
                    </Button>
                    <Button
                      size="small"
                      variant="contained"
                      startIcon={<ReplayIcon fontSize="small" />}
                      onClick={() => handleJobAction(job.id, 'retry')}
                      disabled={isActioning}
                    >
                      Wiederholen
                    </Button>
                  </Stack>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    );
  };

  return (
    <Box>
      <PageHeader
        title="SharePoint Upload"
        icon={<UploadFileIcon />}
        breadcrumb={[{ label: 'SharePoint Upload' }]}
        subtitle="Anlagen zusammenführen und Upload-Jobs steuern"
      />

      {successMessage && (
        <Alert
          severity="success"
          sx={{ mb: 2 }}
          onClose={() => setSuccessMessage(null)}
        >
          {successMessage}
        </Alert>
      )}

      <Paper elevation={1} sx={{ width: '100%' }}>
        <Tabs
          value={tab}
          onChange={(_, newValue) => setTab(newValue)}
          aria-label="SharePoint Upload Tabs"
          variant="fullWidth"
        >
          <Tab label="Anlagen" />
          <Tab label="Jobs" />
        </Tabs>

        <TabPanel value={tab} index={0}>
          {folderError && (
            <Alert severity="error" sx={{ mb: 2 }} onClose={() => setFolderError(null)}>
              {folderError}
            </Alert>
          )}
          {tenantsError && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {tenantsError}
            </Alert>
          )}
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ xs: 'stretch', sm: 'center' }} sx={{ mb: 2 }}>
            <Typography variant="body2" color="text.secondary" sx={{ flexGrow: 1 }}>
              {folderMeta
                ? `Basis: ${folderMeta.base} • Insgesamt: ${folderMeta.total}`
                : 'Ordnerübersicht'}
            </Typography>
            <Typography variant="body2">Ausgewählt: {selectedFolders.length}</Typography>
            <FormControl size="small" sx={{ minWidth: 200 }}>
              <InputLabel id="tenant-select-label">Mandant</InputLabel>
              <Select
                labelId="tenant-select-label"
                value={tenantId}
                label="Mandant"
                onChange={(event) => setTenantId(event.target.value as string)}
                disabled={tenantsLoading || tenants.length === 0}
              >
                {tenants.map((tenant) => (
                  <MenuItem key={tenant.id} value={tenant.id}>
                    {tenant.name}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <FormControl size="small" sx={{ minWidth: 160 }}>
              <InputLabel id="order-label">Reihenfolge</InputLabel>
              <Select
                labelId="order-label"
                value={order}
                label="Reihenfolge"
                onChange={handleChangeOrder}
              >
                <MenuItem value="alpha">Alphabetisch</MenuItem>
                <MenuItem value="name_asc">Name aufsteigend</MenuItem>
                <MenuItem value="name_desc">Name absteigend</MenuItem>
              </Select>
            </FormControl>
            <Stack direction="row" spacing={1}>
              <Button
                variant="outlined"
                onClick={loadFolders}
                disabled={foldersLoading}
              >
                Aktualisieren
              </Button>
              <Button
                variant="contained"
                onClick={startJobs}
                disabled={
                  selectedFolders.length === 0 ||
                  creatingJobs ||
                  !tenantId
                }
              >
                {creatingJobs ? 'Starte...' : 'Jobs starten'}
              </Button>
            </Stack>
          </Stack>

          <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1, overflow: 'hidden' }}>
            {renderFoldersTable()}
          </Box>
        </TabPanel>

        <TabPanel value={tab} index={1}>
          {jobError && (
            <Alert severity="error" sx={{ mb: 2 }} onClose={() => setJobError(null)}>
              {jobError}
            </Alert>
          )}
          {pipelineError && (
            <Alert severity="error" sx={{ mb: 2 }} onClose={() => setPipelineError(null)}>
              {pipelineError}
            </Alert>
          )}
          <Stack direction="row" justifyContent="flex-end" sx={{ mb: 2 }} spacing={1}>
            <Button variant="outlined" onClick={() => loadJobs()} disabled={jobsLoading}>
              {jobsLoading ? 'Lädt...' : 'Aktualisieren'}
            </Button>
          </Stack>
          <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1, overflow: 'hidden' }}>
            {renderJobsTable()}
          </Box>
        </TabPanel>
      </Paper>
    </Box>
  );
}
