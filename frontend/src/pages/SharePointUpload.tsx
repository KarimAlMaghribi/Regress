import React from 'react';
import axios from 'axios';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  CircularProgress,
  Chip,
  Divider,
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
  fetchProcessedFolders,
  runProcessedFolders,
  fetchAggregatedJobs,
} from '../utils/ingestApi';
import type {
  FolderSummary,
  JobOrder,
  JobStatus,
  JobSummary,
  ProcessedFolderSummary,
  AggregatedJobEntry,
  AggregatedJobSource,
} from '../types/ingest';
import {useTenants} from '../hooks/useTenants';
import {usePipelineList} from '../hooks/usePipelineList';
import {INGEST_API} from '../utils/api';

const statusChipColor: Record<
  JobStatus,
  'default' | 'primary' | 'secondary' | 'error' | 'info' | 'success' | 'warning'
> = {
  queued: 'info',
  running: 'primary',
  paused: 'warning',
  succeeded: 'success',
  failed: 'error',
  canceled: 'default',
};

const aggregatedSourceColor: Record<
  AggregatedJobSource,
  'default' | 'primary' | 'secondary' | 'error' | 'info' | 'success' | 'warning'
> = {
  sharepoint: 'primary',
  pipeline: 'secondary',
};

const aggregatedSourceLabel: Record<AggregatedJobSource, string> = {
  sharepoint: 'SharePoint',
  pipeline: 'Pipeline',
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
    const data = error.response?.data as {message?: string} | string | undefined;
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

interface TabPanelProps {
  children?: React.ReactNode;
  index: number;
  value: number;
}

function TabPanel({children, value, index}: TabPanelProps) {
  return (
    <div role="tabpanel" hidden={value !== index}>
      {value === index && <Box sx={{pt: 3, px: 3, pb: 3}}>{children}</Box>}
    </div>
  );
}

const clampProgress = (value?: number | null): number => {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
};

const toPercent = (value?: number | null): number => Math.round(clampProgress(value) * 100);

const formatDateTime = (value?: string | null): string => {
  if (!value) {
    return '—';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
};

const uploadStatusLabels: Record<string, string> = {
  ready: 'Text fertig',
  ocr: 'OCR läuft',
  merging: 'Upload läuft',
  error: 'Fehler',
  failed: 'Fehlgeschlagen',
};

const getUploadStatusLabel = (value: string): string => {
  const normalized = value.toLowerCase();
  if (uploadStatusLabels[normalized]) {
    return uploadStatusLabels[normalized];
  }
  return value
    .split(/[_\s]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
};

const getUploadStatusColor = (
  value: string,
): 'default' | 'primary' | 'secondary' | 'error' | 'info' | 'success' | 'warning' => {
  const normalized = value.toLowerCase();
  switch (normalized) {
    case 'ready':
      return 'success';
    case 'ocr':
      return 'info';
    case 'merging':
      return 'warning';
    case 'failed':
    case 'error':
      return 'error';
    default:
      return 'default';
  }
};

export default function SharePointUpload() {
  const [tab, setTab] = React.useState(0);
  const [folders, setFolders] = React.useState<FolderSummary[]>([]);
  const [folderMeta, setFolderMeta] = React.useState<{base: string; total: number} | null>(null);
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
  const {items: tenants, loading: tenantsLoading, error: tenantsError} = useTenants();
  const [tenantId, setTenantId] = React.useState<string>('');
  const {pipelines, loading: pipelinesLoading, error: pipelinesError} = usePipelineList();
  const uploadBase = React.useMemo(() => INGEST_API.replace(/\/$/, ''), []);
  const [pendingProcessed, setPendingProcessed] = React.useState<ProcessedFolderSummary[]>([]);
  const [pendingLoading, setPendingLoading] = React.useState(false);
  const [pendingError, setPendingError] = React.useState<string | null>(null);
  const [completedProcessed, setCompletedProcessed] = React.useState<ProcessedFolderSummary[]>([]);
  const [completedLoading, setCompletedLoading] = React.useState(false);
  const [completedError, setCompletedError] = React.useState<string | null>(null);
  const [selectedProcessed, setSelectedProcessed] = React.useState<string[]>([]);
  const [processingPipelineId, setProcessingPipelineId] = React.useState<string>('');
  const [processing, setProcessing] = React.useState(false);
  const [aggregatedJobs, setAggregatedJobs] = React.useState<AggregatedJobEntry[]>([]);
  const [aggregatedLoading, setAggregatedLoading] = React.useState(false);
  const [aggregatedError, setAggregatedError] = React.useState<string | null>(null);

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

  React.useEffect(() => {
    if (pipelines.length === 0) {
      if (processingPipelineId) {
        setProcessingPipelineId('');
      }
      return;
    }
    if (pipelines.length === 1 && !processingPipelineId) {
      setProcessingPipelineId(pipelines[0].id);
      return;
    }
    if (processingPipelineId && pipelines.every((pipeline) => pipeline.id !== processingPipelineId)) {
      setProcessingPipelineId('');
    }
  }, [pipelines, processingPipelineId]);

  const loadFolders = React.useCallback(async () => {
    setFoldersLoading(true);
    setFolderError(null);
    try {
      const data = await fetchFolders();
      setFolders(data.items);
      setFolderMeta({base: data.base, total: data.total});
    } catch (error) {
      setFolderError(getErrorMessage(error));
      setFolders([]);
      setFolderMeta(null);
    } finally {
      setFoldersLoading(false);
    }
  }, []);

  const loadJobs = React.useCallback(
    async (options?: {silent?: boolean}) => {
      const silent = options?.silent ?? false;
      if (!silent) {
        setJobsLoading(true);
      }
      try {
        const data = await fetchJobs();
        setJobs(data.jobs);
        setJobError(null);
      } catch (error) {
        setJobError(getErrorMessage(error));
        setJobs([]);
      } finally {
        if (!silent) {
          setJobsLoading(false);
        }
      }
    },
    [],
  );

  const loadPendingProcessed = React.useCallback(
    async (options?: {silent?: boolean}) => {
      const silent = options?.silent ?? false;
      if (!silent) {
        setPendingLoading(true);
      }
      try {
        const data = await fetchProcessedFolders({stage: 'pending'});
        setPendingProcessed(data.items);
        setPendingError(null);
        setSelectedProcessed((prev) => prev.filter((id) => data.items.some((item) => item.job_id === id)));
      } catch (error) {
        setPendingError(getErrorMessage(error));
        setPendingProcessed([]);
        setSelectedProcessed([]);
      } finally {
        if (!silent) {
          setPendingLoading(false);
        }
      }
    },
    [],
  );

  const loadCompletedProcessed = React.useCallback(
    async (options?: {silent?: boolean}) => {
      const silent = options?.silent ?? false;
      if (!silent) {
        setCompletedLoading(true);
      }
      try {
        const data = await fetchProcessedFolders({stage: 'completed'});
        setCompletedProcessed(data.items);
        setCompletedError(null);
      } catch (error) {
        setCompletedError(getErrorMessage(error));
        setCompletedProcessed([]);
      } finally {
        if (!silent) {
          setCompletedLoading(false);
        }
      }
    },
    [],
  );

  const loadAggregatedJobs = React.useCallback(
    async (options?: {silent?: boolean}) => {
      const silent = options?.silent ?? false;
      if (!silent) {
        setAggregatedLoading(true);
      }
      try {
        const data = await fetchAggregatedJobs();
        setAggregatedJobs(data.jobs);
        setAggregatedError(null);
      } catch (error) {
        setAggregatedError(getErrorMessage(error));
        setAggregatedJobs([]);
      } finally {
        if (!silent) {
          setAggregatedLoading(false);
        }
      }
    },
    [],
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
      await loadPendingProcessed();
    };

    loadInitial();

    const intervalId = window.setInterval(() => {
      if (!cancelled) {
        loadPendingProcessed({silent: true});
      }
    }, INGEST_POLL_INTERVAL);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [tab, loadPendingProcessed]);

  React.useEffect(() => {
    if (tab !== 2) {
      return undefined;
    }

    let cancelled = false;

    const loadInitial = async () => {
      await loadCompletedProcessed();
    };

    loadInitial();

    const intervalId = window.setInterval(() => {
      if (!cancelled) {
        loadCompletedProcessed({silent: true});
      }
    }, INGEST_POLL_INTERVAL);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [tab, loadCompletedProcessed]);

  React.useEffect(() => {
    let cancelled = false;

    const loadInitial = async () => {
      await loadJobs();
      await loadAggregatedJobs();
    };

    loadInitial();

    const intervalId = window.setInterval(() => {
      if (!cancelled) {
        loadJobs({silent: true});
        loadAggregatedJobs({silent: true});
      }
    }, INGEST_POLL_INTERVAL);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [loadJobs, loadAggregatedJobs]);

  const allSelected = folders.length > 0 && selectedFolders.length === folders.length;
  const isIndeterminate = selectedFolders.length > 0 && !allSelected;

  const handleToggleFolder = (id: string) => {
    setSelectedFolders((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
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

  const allPendingSelected = pendingProcessed.length > 0 && selectedProcessed.length === pendingProcessed.length;
  const pendingIndeterminate = selectedProcessed.length > 0 && !allPendingSelected;

  const handleToggleProcessed = (id: string) => {
    setSelectedProcessed((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
  };

  const handleSelectAllProcessed = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.checked) {
      setSelectedProcessed(pendingProcessed.map((item) => item.job_id));
    } else {
      setSelectedProcessed([]);
    }
  };

  const startProcessing = async () => {
    const pipelineId = processingPipelineId || (pipelines.length === 1 ? pipelines[0].id : '');
    if (!pipelineId) {
      setPendingError('Bitte wähle eine Pipeline aus.');
      return;
    }
    if (selectedProcessed.length === 0) {
      setPendingError('Bitte wähle mindestens einen Ordner zur Verarbeitung aus.');
      return;
    }
    setProcessing(true);
    setSuccessMessage(null);
    setPendingError(null);
    try {
      const response = await runProcessedFolders({
        job_ids: selectedProcessed,
        pipeline_id: pipelineId,
      });
      const startedCount = response.started.length;
      const skippedCount = response.skipped.length;
      const parts: string[] = [];
      if (startedCount > 0) {
        parts.push(`${startedCount} gestartet`);
      }
      if (skippedCount > 0) {
        parts.push(`${skippedCount} übersprungen`);
      }
      if (parts.length > 0) {
        setSuccessMessage(`Pipeline-Ausführung: ${parts.join(', ')}.`);
      } else {
        setSuccessMessage('Keine Aufträge gestartet.');
      }
      if (response.skipped.length > 0) {
        setPendingError(
          response.skipped.map((item) => `${item.job_id.substring(0, 8)}: ${item.reason}`).join(' • '),
        );
      }
      const startedIds = new Set(response.started.map((item) => item.job_id));
      setSelectedProcessed((prev) => prev.filter((id) => !startedIds.has(id)));
      await loadPendingProcessed();
      await loadCompletedProcessed({silent: true});
      await loadJobs({silent: true});
      await loadAggregatedJobs({silent: true});
    } catch (error) {
      setPendingError(getErrorMessage(error));
    } finally {
      setProcessing(false);
    }
  };

  const startJobs = async () => {
    if (!tenantId) {
      setFolderError('Bitte wähle einen Mandanten aus, bevor Jobs gestartet werden.');
      return;
    }
    if (selectedFolders.length === 0) {
      setFolderError('Bitte wähle mindestens einen Ordner aus.');
      return;
    }
    setCreatingJobs(true);
    setSuccessMessage(null);
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
      await loadJobs();
      await loadAggregatedJobs({silent: true});
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
      await loadAggregatedJobs({silent: true});
    } catch (error) {
      setJobError(getErrorMessage(error));
    } finally {
      setActioningJobId(null);
    }
  };

  const refreshAggregatedAndJobs = React.useCallback(async () => {
    await loadJobs();
    await loadAggregatedJobs();
  }, [loadJobs, loadAggregatedJobs]);

  const renderFoldersTable = () => {
    if (foldersLoading) {
      return (
        <Box sx={{display: 'flex', justifyContent: 'center', py: 6}}>
          <CircularProgress />
        </Box>
      );
    }

    if (folders.length === 0) {
      return (
        <Box sx={{py: 6, textAlign: 'center'}}>
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
                inputProps={{'aria-label': 'alle Anlagen auswählen'}}
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
                    inputProps={{'aria-label': `${folder.name} auswählen`}}
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

  const renderPendingProcessedTable = () => {
    if (pendingLoading && pendingProcessed.length === 0) {
      return (
        <Box sx={{display: 'flex', justifyContent: 'center', py: 6}}>
          <CircularProgress />
        </Box>
      );
    }

    if (!pendingLoading && pendingProcessed.length === 0) {
      return (
        <Box sx={{py: 6, textAlign: 'center'}}>
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
                indeterminate={pendingIndeterminate}
                checked={allPendingSelected}
                onChange={handleSelectAllProcessed}
                inputProps={{'aria-label': 'alle verarbeiteten Ordner auswählen'}}
              />
            </TableCell>
            <TableCell>Ordner</TableCell>
            <TableCell>Mandant</TableCell>
            <TableCell>Status</TableCell>
            <TableCell>Textstatus</TableCell>
            <TableCell>Fortschritt</TableCell>
            <TableCell>Pipeline</TableCell>
            <TableCell>Upload</TableCell>
            <TableCell>Aktualisiert</TableCell>
            <TableCell>Nachricht</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {pendingProcessed.map((item) => {
            const checked = selectedProcessed.includes(item.job_id);
            const percent = toPercent(item.progress);
            const tenantLabel = item.tenant_id ? tenantNameMap.get(item.tenant_id) ?? item.tenant_id : null;
            const uploadStatus = item.upload_status ?? null;
            return (
              <TableRow key={item.job_id} hover selected={checked}>
                <TableCell padding="checkbox">
                  <Checkbox
                    checked={checked}
                    onChange={() => handleToggleProcessed(item.job_id)}
                    inputProps={{'aria-label': `${item.folder_name} auswählen`}}
                  />
                </TableCell>
                <TableCell>{item.folder_name}</TableCell>
                <TableCell>
                  {tenantLabel ? (
                    <Chip label={tenantLabel} size="small" />
                  ) : (
                    <Typography variant="body2" color="text.secondary">
                      —
                    </Typography>
                  )}
                </TableCell>
                <TableCell>
                  <Chip label={item.status} size="small" color={statusChipColor[item.status]} />
                </TableCell>
                <TableCell>
                  {uploadStatus ? (
                    <Chip
                      label={getUploadStatusLabel(uploadStatus)}
                      size="small"
                      color={getUploadStatusColor(uploadStatus)}
                    />
                  ) : (
                    <Typography variant="body2" color="text.secondary">
                      —
                    </Typography>
                  )}
                </TableCell>
                <TableCell>
                  <Stack spacing={1} sx={{minWidth: 140}}>
                    <LinearProgress variant="determinate" value={percent} />
                    <Typography variant="caption" color="text.secondary">
                      {percent}%
                    </Typography>
                  </Stack>
                </TableCell>
                <TableCell sx={{minWidth: 160}}>
                  {item.pipeline_id ? (
                    <Stack spacing={0.5}>
                      <Typography variant="body2">Pipeline-ID: {item.pipeline_id}</Typography>
                      {item.pipeline_run_id && (
                        <Typography variant="caption" color="text.secondary">
                          Lauf-ID: {item.pipeline_run_id}
                        </Typography>
                      )}
                    </Stack>
                  ) : (
                    <Typography variant="body2" color="text.secondary">
                      —
                    </Typography>
                  )}
                </TableCell>
                <TableCell sx={{minWidth: 180}}>
                  <Stack spacing={0.5}>
                    {item.pdf_id != null && <Typography variant="body2">PDF #{item.pdf_id}</Typography>}
                    {item.upload_id != null ? (
                      <Typography variant="caption" color="text.secondary">
                        Upload-ID {item.upload_id}
                      </Typography>
                    ) : (
                      <Typography variant="caption" color="text.secondary">—</Typography>
                    )}
                  </Stack>
                </TableCell>
                <TableCell>{formatDateTime(item.updated_at)}</TableCell>
                <TableCell sx={{maxWidth: 260}}>
                  <Typography variant="body2" noWrap title={item.message ?? ''}>
                    {item.message ?? '—'}
                  </Typography>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    );
  };

  const renderCompletedProcessedTable = () => {
    if (completedLoading && completedProcessed.length === 0) {
      return (
        <Box sx={{display: 'flex', justifyContent: 'center', py: 6}}>
          <CircularProgress />
        </Box>
      );
    }

    if (!completedLoading && completedProcessed.length === 0) {
      return (
        <Box sx={{py: 6, textAlign: 'center'}}>
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
            <TableCell>Textstatus</TableCell>
            <TableCell>Pipeline-Status</TableCell>
            <TableCell>Fortschritt</TableCell>
            <TableCell>Pipeline</TableCell>
            <TableCell>Upload</TableCell>
            <TableCell>Gestartet</TableCell>
            <TableCell>Beendet</TableCell>
            <TableCell>Nachricht</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {completedProcessed.map((item) => {
            const tenantLabel = item.tenant_id ? tenantNameMap.get(item.tenant_id) ?? item.tenant_id : null;
            const uploadStatus = item.upload_status ?? null;
            const pipelineStatus = item.pipeline_status ?? null;
            const pipelineCategory = item.pipeline_status_category ?? null;
            const hasPipelineProgress = typeof item.pipeline_progress === 'number';
            const pipelinePercent = hasPipelineProgress ? toPercent(item.pipeline_progress) : null;
            const message = item.pipeline_error ?? item.message ?? '—';
            const messageTitle = item.pipeline_error ?? item.message ?? '';
            return (
              <TableRow key={item.job_id} hover>
                <TableCell>{item.folder_name}</TableCell>
                <TableCell>
                  {tenantLabel ? (
                    <Chip label={tenantLabel} size="small" />
                  ) : (
                    <Typography variant="body2" color="text.secondary">
                      —
                    </Typography>
                  )}
                </TableCell>
                <TableCell>
                  {uploadStatus ? (
                    <Chip
                      label={getUploadStatusLabel(uploadStatus)}
                      size="small"
                      color={getUploadStatusColor(uploadStatus)}
                    />
                  ) : (
                    <Typography variant="body2" color="text.secondary">
                      —
                    </Typography>
                  )}
                </TableCell>
                <TableCell>
                  {pipelineStatus ? (
                    <Chip
                      label={pipelineStatus}
                      size="small"
                      color={pipelineCategory ? statusChipColor[pipelineCategory] : 'default'}
                    />
                  ) : (
                    <Typography variant="body2" color="text.secondary">
                      —
                    </Typography>
                  )}
                </TableCell>
                <TableCell>
                  {hasPipelineProgress && pipelinePercent !== null ? (
                    <Stack spacing={1} sx={{minWidth: 140}}>
                      <LinearProgress variant="determinate" value={pipelinePercent} />
                      <Typography variant="caption" color="text.secondary">
                        {pipelinePercent}%
                      </Typography>
                    </Stack>
                  ) : (
                    <Typography variant="body2" color="text.secondary">
                      —
                    </Typography>
                  )}
                </TableCell>
                <TableCell sx={{minWidth: 160}}>
                  {item.pipeline_id ? (
                    <Stack spacing={0.5}>
                      <Typography variant="body2">Pipeline-ID: {item.pipeline_id}</Typography>
                      {item.pipeline_run_id && (
                        <Typography variant="caption" color="text.secondary">
                          Lauf-ID: {item.pipeline_run_id}
                        </Typography>
                      )}
                    </Stack>
                  ) : (
                    <Typography variant="body2" color="text.secondary">
                      —
                    </Typography>
                  )}
                </TableCell>
                <TableCell sx={{minWidth: 180}}>
                  <Stack spacing={0.5}>
                    {item.pdf_id != null && <Typography variant="body2">PDF #{item.pdf_id}</Typography>}
                    {item.upload_id != null ? (
                      <Typography variant="caption" color="text.secondary">
                        Upload-ID {item.upload_id}
                      </Typography>
                    ) : (
                      <Typography variant="caption" color="text.secondary">—</Typography>
                    )}
                  </Stack>
                </TableCell>
                <TableCell>{formatDateTime(item.pipeline_started_at)}</TableCell>
                <TableCell>{formatDateTime(item.pipeline_finished_at ?? item.updated_at)}</TableCell>
                <TableCell sx={{maxWidth: 280}}>
                  <Typography variant="body2" noWrap title={messageTitle}>
                    {message}
                  </Typography>
                </TableCell>
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
        <Box sx={{display: 'flex', justifyContent: 'center', py: 6}}>
          <CircularProgress />
        </Box>
      );
    }

    if (!jobsLoading && jobs.length === 0) {
      return (
        <Box sx={{py: 6, textAlign: 'center'}}>
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
            <TableCell>Upload</TableCell>
            <TableCell>Status</TableCell>
            <TableCell>Fortschritt</TableCell>
            <TableCell>Nachricht</TableCell>
            <TableCell align="right">Aktionen</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {jobs.map((job) => {
            const percent = toPercent(job.progress);
            const isActioning = actioningJobId === job.id;
            const disableCancel = ['canceled', 'failed', 'succeeded'].includes(job.status);
            const tenantLabel = job.tenant_id ? tenantNameMap.get(job.tenant_id) ?? job.tenant_id : null;
            const pdfId = job.pdf_id ?? job.output?.pdf_id ?? null;
            const uploadId = job.upload_id ?? job.output?.upload_id ?? null;
            const uploadStatus = job.output?.status ?? null;
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
                <TableCell sx={{minWidth: 200}}>
                  <Stack spacing={0.5}>
                    {pdfId != null && <Typography variant="body2">PDF #{pdfId}</Typography>}
                    {uploadId != null ? (
                      <Typography variant="caption" color="text.secondary">
                        Upload-ID {uploadId}
                        {uploadStatus ? ` • Status: ${uploadStatus}` : ''}
                      </Typography>
                    ) : (
                      <Typography variant="caption" color="text.secondary">
                        Upload wird vorbereitet…
                      </Typography>
                    )}
                  </Stack>
                </TableCell>
                <TableCell>
                  <Chip label={job.status} size="small" color={statusChipColor[job.status]} />
                </TableCell>
                <TableCell>
                  <Stack spacing={1} sx={{minWidth: 140}}>
                    <LinearProgress variant="determinate" value={percent} />
                    <Typography variant="caption" color="text.secondary">
                      {percent}%
                    </Typography>
                  </Stack>
                </TableCell>
                <TableCell sx={{maxWidth: 280}}>
                  <Typography variant="body2" noWrap title={job.message ?? ''}>
                    {job.message ?? '—'}
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

  const renderAggregatedJobsTable = () => {
    if (aggregatedLoading && aggregatedJobs.length === 0) {
      return (
        <Box sx={{display: 'flex', justifyContent: 'center', py: 6}}>
          <CircularProgress />
        </Box>
      );
    }

    if (!aggregatedLoading && aggregatedJobs.length === 0) {
      return (
        <Box sx={{py: 6, textAlign: 'center'}}>
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
            <TableCell>Quelle</TableCell>
            <TableCell>Bezeichnung</TableCell>
            <TableCell>Status</TableCell>
            <TableCell>Fortschritt</TableCell>
            <TableCell>Upload</TableCell>
            <TableCell>Nachricht</TableCell>
            <TableCell>Erstellt</TableCell>
            <TableCell>Aktualisiert</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {aggregatedJobs.map((entry) => {
            const percent = toPercent(entry.progress);
            const name = entry.source === 'pipeline' ? entry.pipeline_name ?? entry.folder_name ?? '—' : entry.folder_name ?? '—';
            return (
              <TableRow key={entry.id} hover>
                <TableCell>
                  <Chip label={aggregatedSourceLabel[entry.source]} size="small" color={aggregatedSourceColor[entry.source]} />
                </TableCell>
                <TableCell>{name}</TableCell>
                <TableCell>
                  <Chip label={entry.status} size="small" color={statusChipColor[entry.status_category]} />
                </TableCell>
                <TableCell>
                  <Stack spacing={1} sx={{minWidth: 140}}>
                    <LinearProgress variant="determinate" value={percent} />
                    <Typography variant="caption" color="text.secondary">
                      {percent}%
                    </Typography>
                  </Stack>
                </TableCell>
                <TableCell sx={{minWidth: 180}}>
                  <Stack spacing={0.5}>
                    {entry.pdf_id != null && <Typography variant="body2">PDF #{entry.pdf_id}</Typography>}
                    {entry.upload_id != null ? (
                      <Typography variant="caption" color="text.secondary">
                        Upload-ID {entry.upload_id}
                      </Typography>
                    ) : (
                      <Typography variant="caption" color="text.secondary">—</Typography>
                    )}
                  </Stack>
                </TableCell>
                <TableCell sx={{maxWidth: 280}}>
                  <Typography variant="body2" noWrap title={entry.message ?? ''}>
                    {entry.message ?? '—'}
                  </Typography>
                </TableCell>
                <TableCell>{formatDateTime(entry.created_at)}</TableCell>
                <TableCell>{formatDateTime(entry.updated_at ?? null)}</TableCell>
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
        breadcrumb={[{label: 'SharePoint Upload'}]}
        subtitle="Anlagen zusammenführen und Upload-Jobs steuern"
      />

      {successMessage && (
        <Alert severity="success" sx={{mb: 2}} onClose={() => setSuccessMessage(null)}>
          {successMessage}
        </Alert>
      )}

      <Paper elevation={1} sx={{width: '100%'}}>
        <Tabs
          value={tab}
          onChange={(_, newValue) => setTab(newValue)}
          aria-label="SharePoint Upload Tabs"
          variant="fullWidth"
        >
          <Tab label="Anlagen" />
          <Tab label="Verarbeitung" />
          <Tab label="Fertig" />
        </Tabs>

        <TabPanel value={tab} index={0}>
          {folderError && (
            <Alert severity="error" sx={{mb: 2}} onClose={() => setFolderError(null)}>
              {folderError}
            </Alert>
          )}
          {tenantsError && (
            <Alert severity="error" sx={{mb: 2}}>
              {tenantsError}
            </Alert>
          )}
          <Stack
            direction={{xs: 'column', sm: 'row'}}
            spacing={2}
            alignItems={{xs: 'stretch', sm: 'center'}}
            sx={{mb: 2}}
          >
            <Typography variant="body2" color="text.secondary" sx={{flexGrow: 1}}>
              {folderMeta ? `Basis: ${folderMeta.base} • Verfügbar: ${folderMeta.total}` : 'Ordnerübersicht'}
            </Typography>
            <Typography variant="body2">Ausgewählt: {selectedFolders.length}</Typography>
            <FormControl size="small" sx={{minWidth: 200}}>
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
            <FormControl size="small" sx={{minWidth: 160}}>
              <InputLabel id="order-label">Reihenfolge</InputLabel>
              <Select labelId="order-label" value={order} label="Reihenfolge" onChange={handleChangeOrder}>
                <MenuItem value="alpha">Alphabetisch</MenuItem>
                <MenuItem value="name_asc">Name aufsteigend</MenuItem>
                <MenuItem value="name_desc">Name absteigend</MenuItem>
              </Select>
            </FormControl>
            <Stack direction="row" spacing={1}>
              <Button variant="outlined" onClick={loadFolders} disabled={foldersLoading}>
                Aktualisieren
              </Button>
              <Button
                variant="contained"
                onClick={startJobs}
                disabled={selectedFolders.length === 0 || creatingJobs || !tenantId}
              >
                {creatingJobs ? 'Starte…' : 'Jobs starten'}
              </Button>
            </Stack>
          </Stack>

          <Box sx={{border: 1, borderColor: 'divider', borderRadius: 1, overflow: 'hidden'}}>
            {renderFoldersTable()}
          </Box>
        </TabPanel>

        <TabPanel value={tab} index={1}>
          {pendingError && (
            <Alert severity="error" sx={{mb: 2}} onClose={() => setPendingError(null)}>
              {pendingError}
            </Alert>
          )}
          {pipelinesError && (
            <Alert severity="error" sx={{mb: 2}}>
              {pipelinesError}
            </Alert>
          )}
          {pipelines.length === 0 && !pipelinesLoading && (
            <Alert severity="info" sx={{mb: 2}}>
              Keine Pipelines verfügbar. Bitte lege im Pipeline-Manager einen Lauf an.
            </Alert>
          )}
          <Stack
            direction={{xs: 'column', md: 'row'}}
            spacing={2}
            alignItems={{xs: 'stretch', md: 'center'}}
            sx={{mb: 2}}
          >
            <Typography variant="body2" color="text.secondary" sx={{flexGrow: 1}}>
              Ausgewählt: {selectedProcessed.length} von {pendingProcessed.length}
            </Typography>
            <FormControl size="small" sx={{minWidth: 200}} disabled={pipelines.length === 0}>
              <InputLabel id="pipeline-select-label">Pipeline</InputLabel>
              <Select
                labelId="pipeline-select-label"
                value={processingPipelineId}
                label="Pipeline"
                onChange={(event: SelectChangeEvent<string>) => setProcessingPipelineId(event.target.value)}
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
            <Stack direction="row" spacing={1}>
              <Button variant="outlined" onClick={() => loadPendingProcessed()} disabled={pendingLoading}>
                {pendingLoading ? 'Lädt…' : 'Aktualisieren'}
              </Button>
              <Button
                variant="contained"
                onClick={startProcessing}
                disabled={
                  processing ||
                  selectedProcessed.length === 0 ||
                  pipelines.length === 0 ||
                  pipelinesLoading
                }
                startIcon={
                  processing ? <CircularProgress size={16} color="inherit" /> : <PlayArrowIcon fontSize="small" />
                }
              >
                {processing ? 'Startet…' : 'Pipeline starten'}
              </Button>
            </Stack>
          </Stack>

          <Box sx={{border: 1, borderColor: 'divider', borderRadius: 1, overflow: 'hidden'}}>
            {renderPendingProcessedTable()}
          </Box>
        </TabPanel>

        <TabPanel value={tab} index={2}>
          {completedError && (
            <Alert severity="error" sx={{mb: 2}} onClose={() => setCompletedError(null)}>
              {completedError}
            </Alert>
          )}
          <Stack direction="row" justifyContent="flex-end" sx={{mb: 2}} spacing={1}>
            <Button variant="outlined" onClick={() => loadCompletedProcessed()} disabled={completedLoading}>
              {completedLoading ? 'Lädt…' : 'Aktualisieren'}
            </Button>
          </Stack>

          <Box sx={{border: 1, borderColor: 'divider', borderRadius: 1, overflow: 'hidden'}}>
            {renderCompletedProcessedTable()}
          </Box>
        </TabPanel>

        <Divider sx={{mt: 3}} />
        <Box sx={{px: 3, py: 3}}>
          <Stack direction="row" justifyContent="flex-end" sx={{mb: 2}} spacing={1}>
            <Button
              variant="outlined"
              onClick={refreshAggregatedAndJobs}
              disabled={jobsLoading || aggregatedLoading}
            >
              {(jobsLoading || aggregatedLoading) ? 'Lädt…' : 'Aktualisieren'}
            </Button>
          </Stack>

          {aggregatedError && (
            <Alert severity="error" sx={{mb: 2}} onClose={() => setAggregatedError(null)}>
              {aggregatedError}
            </Alert>
          )}
          <Typography variant="h6" sx={{mb: 1}}>
            Aggregierte Jobs
          </Typography>
          <Box sx={{border: 1, borderColor: 'divider', borderRadius: 1, overflow: 'hidden', mb: 3}}>
            {renderAggregatedJobsTable()}
          </Box>

          {jobError && (
            <Alert severity="error" sx={{mb: 2}} onClose={() => setJobError(null)}>
              {jobError}
            </Alert>
          )}
          <Typography variant="h6" sx={{mb: 1}}>
            SharePoint-Jobs
          </Typography>
          <Box sx={{border: 1, borderColor: 'divider', borderRadius: 1, overflow: 'hidden'}}>
            {renderJobsTable()}
          </Box>
        </Box>
      </Paper>
    </Box>
  );
}
