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
  Switch,
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
  fetchAutomationSettings,
  updateAutomationSetting,
} from '../utils/ingestApi';
import type {
  FolderSummary,
  JobOrder,
  JobStatus,
  JobSummary,
  ProcessedFolderSummary,
  AggregatedJobEntry,
  AggregatedJobSource,
  AutomationDefaultSettings,
  AutomationDefaultUpdate,
} from '../types/ingest';
import {useTenants} from '../hooks/useTenants';
import {usePipelineList} from '../hooks/usePipelineList';
import {INGEST_API} from '../utils/api';
import {Link} from 'react-router-dom';

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

const ACTIVE_AUTOMATION_STATUSES: readonly JobStatus[] = ['queued', 'running'];

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
  const [automationDefaultsLoading, setAutomationDefaultsLoading] = React.useState(false);
  const [automationDefaultsError, setAutomationDefaultsError] = React.useState<string | null>(null);
  const [ingestAutomation, setIngestAutomation] = React.useState<AutomationDefaultSettings | null>(null);
  const [processingAutomation, setProcessingAutomation] = React.useState<AutomationDefaultSettings | null>(null);
  const [automationDefaultsSaving, setAutomationDefaultsSaving] = React.useState<'ingest' | 'processing' | null>(null);
  const [ingestTenantSelection, setIngestTenantSelection] = React.useState<string>('');
  const [processingPipelineSelection, setProcessingPipelineSelection] = React.useState<string>('');
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

  const pipelineNameMap = React.useMemo(() => {
    const map = new Map<string, string>();
    pipelines.forEach((pipeline) => map.set(pipeline.id, pipeline.name));
    return map;
  }, [pipelines]);

  const globalIngestEnabled = ingestAutomation?.enabled ?? false;
  const globalProcessingEnabled = processingAutomation?.enabled ?? false;
  const ingestTenantValue = ingestTenantSelection;
  const processingPipelineValue = processingPipelineSelection;

  React.useEffect(() => {
    setIngestTenantSelection(ingestAutomation?.tenant_id ?? '');
  }, [ingestAutomation?.tenant_id]);

  React.useEffect(() => {
    setProcessingPipelineSelection(processingAutomation?.pipeline_id ?? '');
  }, [processingAutomation?.pipeline_id]);

  const ingestToggleDisabled =
    automationDefaultsLoading ||
    automationDefaultsSaving === 'ingest' ||
    tenants.length === 0 ||
    (!globalIngestEnabled && ingestTenantValue === '');

  const processingToggleDisabled =
    automationDefaultsLoading ||
    automationDefaultsSaving === 'processing' ||
    pipelines.length === 0 ||
    (!globalProcessingEnabled && processingPipelineValue === '');

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

  const loadFolders = React.useCallback(
    async (options?: {silent?: boolean}) => {
      const silent = options?.silent ?? false;
      if (!silent) {
        setFoldersLoading(true);
        setFolderError(null);
      }
      try {
        const data = await fetchFolders();
        setFolders(data.items);
        setFolderMeta({base: data.base, total: data.total});
        const availableFolderIds = new Set(data.items.map((item) => item.id));
        setSelectedFolders((prev) => {
          const filtered = prev.filter((id) => availableFolderIds.has(id));
          return filtered.length === prev.length ? prev : filtered;
        });
        setFolderError(null);
      } catch (error) {
        setFolderError(getErrorMessage(error));
        setFolders([]);
        setFolderMeta(null);
        setSelectedFolders((prev) => (prev.length === 0 ? prev : []));
      } finally {
        if (!silent) {
          setFoldersLoading(false);
        }
      }
    },
    [],
  );

  const loadAutomationSettings = React.useCallback(
    async (options?: {silent?: boolean}) => {
      const silent = options?.silent ?? false;
      if (!silent) {
        setAutomationDefaultsLoading(true);
      }
      try {
        const data = await fetchAutomationSettings();
        const ingest = data.items.find((item) => item.scope === 'ingest') ?? null;
        const processing = data.items.find((item) => item.scope === 'processing') ?? null;
        setIngestAutomation(ingest ?? null);
        setProcessingAutomation(processing ?? null);
        setAutomationDefaultsError(null);
      } catch (error) {
        setAutomationDefaultsError(getErrorMessage(error));
        setIngestAutomation(null);
        setProcessingAutomation(null);
      } finally {
        if (!silent) {
          setAutomationDefaultsLoading(false);
        }
      }
    },
    [],
  );

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

  const applyAutomationSettingUpdate = React.useCallback(
    async <S extends 'ingest' | 'processing'>(scope: S, payload: AutomationDefaultUpdate<S>) => {
      setAutomationDefaultsSaving(scope);
      setSuccessMessage(null);
      try {
        const updated = await updateAutomationSetting(scope, payload);
        if (scope === 'ingest') {
          setIngestAutomation(updated);
          await loadFolders({silent: true});
        } else {
          setProcessingAutomation(updated);
          await loadPendingProcessed({silent: true});
          await loadFolders({silent: true});
        }
        setAutomationDefaultsError(null);
        setSuccessMessage('Automatisierung aktualisiert.');
      } catch (error) {
        setAutomationDefaultsError(getErrorMessage(error));
      } finally {
        setAutomationDefaultsSaving(null);
      }
    },
    [loadFolders, loadPendingProcessed],
  );

  const handleIngestAutomationToggleGlobal = React.useCallback(
    async (enabled: boolean) => {
      if (enabled) {
        if (!ingestTenantValue) {
          setAutomationDefaultsError('Bitte wähle zuerst einen Mandanten für die Automatik aus.');
          return;
        }
        const update: AutomationDefaultUpdate<'ingest'> = {
          enabled: true,
          tenant_id: ingestTenantValue,
        };
        await applyAutomationSettingUpdate('ingest', update);
      } else {
        const update: AutomationDefaultUpdate<'ingest'> = {
          enabled: false,
          tenant_id: null,
        };
        await applyAutomationSettingUpdate('ingest', update);
      }
    },
    [applyAutomationSettingUpdate, ingestTenantValue],
  );

  const handleIngestAutomationTenantChange = React.useCallback(
    async (value: string | null) => {
      const normalized = value ?? '';
      setIngestTenantSelection(normalized);
      if (!value) {
        if (ingestAutomation?.enabled) {
          setAutomationDefaultsError('Der Mandant darf nicht leer sein.');
        }
        return;
      }
      setAutomationDefaultsError(null);
      if (!ingestAutomation || !ingestAutomation.enabled) {
        return;
      }
      const update: AutomationDefaultUpdate<'ingest'> = {
        enabled: true,
        tenant_id: value,
      };
      await applyAutomationSettingUpdate('ingest', update);
    },
    [applyAutomationSettingUpdate, ingestAutomation],
  );

  const handleProcessingAutomationToggleGlobal = React.useCallback(
    async (enabled: boolean) => {
      if (enabled) {
        if (!processingPipelineValue) {
          setAutomationDefaultsError('Bitte wähle zuerst eine Pipeline für die Automatik aus.');
          return;
        }
        const update: AutomationDefaultUpdate<'processing'> = {
          enabled: true,
          pipeline_id: processingPipelineValue,
        };
        await applyAutomationSettingUpdate('processing', update);
      } else {
        await applyAutomationSettingUpdate('processing', {
          enabled: false,
          tenant_id: null,
          pipeline_id: null,
        });
      }
    },
    [applyAutomationSettingUpdate, processingPipelineValue],
  );

  const handleProcessingAutomationPipelineChange = React.useCallback(
    async (value: string | null) => {
      const normalized = value ?? '';
      setProcessingPipelineSelection(normalized);
      if (!value) {
        if (processingAutomation?.enabled) {
          setAutomationDefaultsError('Bitte wähle eine Pipeline für die Automatik aus.');
        }
        return;
      }
      setAutomationDefaultsError(null);
      if (!processingAutomation || !processingAutomation.enabled) {
        return;
      }
      const update: AutomationDefaultUpdate<'processing'> = {
        enabled: true,
        tenant_id: null,
        pipeline_id: value,
      };
      await applyAutomationSettingUpdate('processing', update);
    },
    [applyAutomationSettingUpdate, processingAutomation],
  );

  React.useEffect(() => {
    loadFolders();
  }, [loadFolders]);

  React.useEffect(() => {
    loadAutomationSettings();
  }, [loadAutomationSettings]);

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

  const autoManagedJobIds = React.useMemo(() => {
    const ids = new Set<string>();
    jobs.forEach((job) => {
      if (job.auto_managed) {
        ids.add(job.id);
      }
    });
    return ids;
  }, [jobs]);

  const hasActiveAutoIngestJobs = React.useMemo(
    () => jobs.some((job) => job.auto_managed && ACTIVE_AUTOMATION_STATUSES.includes(job.status)),
    [jobs],
  );

  const hasActiveAutoPipelineRuns = React.useMemo(() => {
    if (autoManagedJobIds.size === 0) {
      return false;
    }
    return aggregatedJobs.some((entry) => {
      if (!entry.sharepoint_job_id) {
        return false;
      }
      if (!autoManagedJobIds.has(entry.sharepoint_job_id)) {
        return false;
      }
      return ACTIVE_AUTOMATION_STATUSES.includes(entry.status_category);
    });
  }, [aggregatedJobs, autoManagedJobIds]);

  React.useEffect(() => {
    if (!hasActiveAutoIngestJobs && !hasActiveAutoPipelineRuns) {
      return undefined;
    }

    void loadFolders({silent: true});
    const intervalId = window.setInterval(() => {
      void loadFolders({silent: true});
    }, INGEST_POLL_INTERVAL);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [hasActiveAutoIngestJobs, hasActiveAutoPipelineRuns, loadFolders]);

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
      await loadFolders({silent: true});
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
      await loadFolders({silent: true});
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
            <TableCell>Automatik</TableCell>
            <TableCell>Mandant (Auto)</TableCell>
            <TableCell>Auto-Pipeline</TableCell>
            <TableCell>Pipeline (Auto)</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {folders.map((folder) => {
            const checked = selectedFolders.includes(folder.id);
            const automation = folder.automation;
            const autoIngest = automation?.auto_ingest ?? false;
            const autoPipeline = automation?.auto_pipeline ?? false;
            const automationTenant = automation?.tenant_id ?? null;
            const automationPipeline = automation?.pipeline_id ?? null;
            const automationSource = folder.automation_source ?? 'folder';
            const isGlobal = automationSource === 'default';
            const tenantLabel =
              automationTenant != null
                ? tenantNameMap.get(automationTenant) ?? automationTenant
                : null;
            const pipelineLabel =
              automationPipeline != null
                ? pipelineNameMap.get(automationPipeline) ?? automationPipeline
                : null;
            const ingestDescription = isGlobal
              ? 'Gesteuert durch den globalen Schalter im Tab „Anlagen“.'
              : 'Nur Anzeige – passe die Automatik über den globalen Tab-Schalter an.';
            const pipelineStartDescription = isGlobal
              ? 'Pipelines werden über den globalen Schalter im Tab „Verarbeitung“ gestartet.'
              : 'Nur Anzeige – verwalte Pipeline-Starts über den Tab „Verarbeitung“.';
            const pipelineAssignmentDescription = isGlobal
              ? 'Pipeline-Standard aus dem Tab „Verarbeitung“.'
              : 'Historische Ordnerregel – Änderungen über globale Einstellungen.';
            return (
              <TableRow key={folder.id} hover selected={checked}>
                <TableCell padding="checkbox">
                  <Checkbox
                    checked={checked}
                    onChange={() => handleToggleFolder(folder.id)}
                    inputProps={{'aria-label': `${folder.name} auswählen`}}
                  />
                </TableCell>
                <TableCell>
                  <Stack spacing={0.5}>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Typography variant="body2">{folder.name}</Typography>
                      {automationSource === 'default' && (
                        <Chip label="Global" size="small" color="secondary" />
                      )}
                    </Stack>
                    {automation?.last_seen && (
                      <Typography variant="caption" color="text.secondary">
                        Zuletzt gesehen: {formatDateTime(automation.last_seen)}
                      </Typography>
                    )}
                  </Stack>
                </TableCell>
                <TableCell align="right">{folder.file_count}</TableCell>
                <TableCell sx={{minWidth: 220}}>
                  <Stack spacing={0.5}>
                    <Chip
                      label={autoIngest ? 'Aktiv' : 'Inaktiv'}
                      size="small"
                      color={autoIngest ? 'success' : 'default'}
                    />
                    <Typography variant="caption" color="text.secondary">
                      {ingestDescription}
                    </Typography>
                  </Stack>
                </TableCell>
                <TableCell sx={{minWidth: 220}}>
                  <Stack spacing={0.5}>
                    {tenantLabel ? (
                      <Chip label={tenantLabel} size="small" />
                    ) : (
                      <Typography variant="body2" color="text.secondary">
                        —
                      </Typography>
                    )}
                    <Typography variant="caption" color="text.secondary">
                      {isGlobal
                        ? 'Vorgabe aus dem globalen Tab-Schalter.'
                        : 'Keine Bearbeitung pro Ordner – nutze den globalen Tab-Schalter.'}
                    </Typography>
                  </Stack>
                </TableCell>
                <TableCell sx={{minWidth: 220}}>
                  <Stack spacing={0.5}>
                    <Chip
                      label={autoPipeline ? 'Aktiv' : 'Inaktiv'}
                      size="small"
                      color={autoPipeline ? 'info' : 'default'}
                    />
                    <Typography variant="caption" color="text.secondary">
                      {pipelineStartDescription}
                    </Typography>
                  </Stack>
                </TableCell>
                <TableCell sx={{minWidth: 220}}>
                  <Stack spacing={0.5}>
                    {pipelineLabel ? (
                      <Chip label={pipelineLabel} size="small" />
                    ) : (
                      <Typography variant="body2" color="text.secondary">
                        —
                      </Typography>
                    )}
                    <Typography variant="caption" color="text.secondary">
                      {pipelineAssignmentDescription}
                    </Typography>
                  </Stack>
                </TableCell>
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
                          <Link
                            to={`/run-view/${item.pipeline_run_id}`}
                            style={{color: 'inherit', textDecoration: 'none'}}
                          >
                            Lauf-ID: {item.pipeline_run_id}
                          </Link>
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
                          <Link
                            to={`/run-view/${item.pipeline_run_id}`}
                            style={{color: 'inherit', textDecoration: 'none'}}
                          >
                            Lauf-ID: {item.pipeline_run_id}
                          </Link>
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
                <TableCell>
                  <Stack direction="row" spacing={1} alignItems="center">
                    <Typography variant="body2">{job.folder_name}</Typography>
                    {job.auto_managed && <Chip label="Auto" size="small" color="primary" />}
                  </Stack>
                </TableCell>
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
          {automationDefaultsError && (
            <Alert
              severity="error"
              sx={{mb: 2}}
              onClose={() => setAutomationDefaultsError(null)}
            >
              {automationDefaultsError}
            </Alert>
          )}
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
          <Box sx={{mb: 2, p: 2, border: 1, borderColor: 'divider', borderRadius: 1}}>
            <Stack spacing={2}>
              <Stack
                direction={{xs: 'column', md: 'row'}}
                spacing={2}
                alignItems={{xs: 'flex-start', md: 'center'}}
                justifyContent="space-between"
              >
                <Stack direction="row" spacing={1} alignItems="center">
                  <Switch
                    checked={globalIngestEnabled}
                    onChange={(_, value) => handleIngestAutomationToggleGlobal(value)}
                    disabled={ingestToggleDisabled}
                    inputProps={{'aria-label': 'globale Anlagen-Automatik'}}
                  />
                  <Typography variant="subtitle1">Automatisch alle Anlagen verarbeiten</Typography>
                  {(automationDefaultsLoading || automationDefaultsSaving === 'ingest') && (
                    <CircularProgress size={16} />
                  )}
                </Stack>
                {!globalIngestEnabled && ingestTenantValue === '' && tenants.length > 0 && (
                  <Typography variant="caption" color="text.secondary">
                    Wähle einen Mandanten, um die Automatik zu aktivieren.
                  </Typography>
                )}
                {ingestAutomation?.updated_at && (
                  <Typography variant="caption" color="text.secondary">
                    Aktualisiert: {formatDateTime(ingestAutomation.updated_at)}
                  </Typography>
                )}
              </Stack>
              <Stack
                direction={{xs: 'column', md: 'row'}}
                spacing={2}
                alignItems={{xs: 'flex-start', md: 'center'}}
              >
                <FormControl
                  size="small"
                  sx={{minWidth: 200}}
                  disabled={
                    automationDefaultsSaving === 'ingest' ||
                    tenants.length === 0 ||
                    tenantsLoading
                  }
                >
                  <InputLabel id="global-automation-tenant">Mandant</InputLabel>
                  <Select
                    labelId="global-automation-tenant"
                    value={ingestTenantValue}
                    label="Mandant"
                    onChange={(event: SelectChangeEvent<string>) =>
                      handleIngestAutomationTenantChange(event.target.value || null)
                    }
                  >
                    <MenuItem value="" disabled>
                      <em>Mandant wählen</em>
                    </MenuItem>
                    {tenants.map((tenant) => (
                      <MenuItem key={tenant.id} value={tenant.id}>
                        {tenant.name}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
                <Typography variant="body2" color="text.secondary" sx={{maxWidth: 360}}>
                  Pipelines werden im Tab „Verarbeitung“ gewählt.
                </Typography>
              </Stack>
              {globalIngestEnabled && (
                <Typography variant="body2" color="text.secondary">
                  Alle neuen Ordner im Tab „Anlagen“ werden automatisch importiert.
                </Typography>
              )}
            </Stack>
          </Box>
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
              <Button variant="outlined" onClick={() => loadFolders()} disabled={foldersLoading}>
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
          {automationDefaultsError && (
            <Alert
              severity="error"
              sx={{mb: 2}}
              onClose={() => setAutomationDefaultsError(null)}
            >
              {automationDefaultsError}
            </Alert>
          )}
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
          <Box sx={{mb: 2, p: 2, border: 1, borderColor: 'divider', borderRadius: 1}}>
            <Stack spacing={2}>
              <Stack direction={{xs: 'column', md: 'row'}} spacing={2} alignItems={{xs: 'flex-start', md: 'center'}}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Switch
                    checked={globalProcessingEnabled}
                    onChange={(_, value) => handleProcessingAutomationToggleGlobal(value)}
                    disabled={processingToggleDisabled}
                    inputProps={{'aria-label': 'globale Pipeline-Automatik'}}
                  />
                  <Typography variant="subtitle1">Pipelines automatisch starten</Typography>
                  {(automationDefaultsLoading || automationDefaultsSaving === 'processing') && (
                    <CircularProgress size={16} />
                  )}
                </Stack>
                {!globalProcessingEnabled && processingPipelineValue === '' && pipelines.length > 0 && (
                  <Typography variant="caption" color="text.secondary">
                    Wähle eine Pipeline, um die Automatik zu aktivieren.
                  </Typography>
                )}
                {processingAutomation?.updated_at && (
                  <Typography variant="caption" color="text.secondary">
                    Aktualisiert: {formatDateTime(processingAutomation.updated_at)}
                  </Typography>
                )}
              </Stack>
              <FormControl
                size="small"
                sx={{minWidth: 200}}
                disabled={
                  automationDefaultsSaving === 'processing' ||
                  pipelines.length === 0 ||
                  pipelinesLoading
                }
              >
                <InputLabel id="global-processing-pipeline">Pipeline</InputLabel>
                <Select
                  labelId="global-processing-pipeline"
                  value={processingPipelineValue}
                  label="Pipeline"
                  onChange={(event: SelectChangeEvent<string>) =>
                    handleProcessingAutomationPipelineChange(
                      event.target.value === '' ? null : event.target.value,
                    )
                  }
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
              {globalProcessingEnabled && (
                <Typography variant="body2" color="text.secondary">
                  Fertige Uploads im Tab „Verarbeitung“ werden automatisch gestartet.
                </Typography>
              )}
            </Stack>
          </Box>
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
