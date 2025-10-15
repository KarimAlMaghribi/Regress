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
} from '../types/ingest';
import axios from 'axios';

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
    setCreatingJobs(true);
    setSuccessMessage(null);
    try {
      await createJobs({
        folder_ids: selectedFolders,
        order,
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
            return (
              <TableRow key={job.id} hover>
                <TableCell>{job.folder_name}</TableCell>
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
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ xs: 'stretch', sm: 'center' }} sx={{ mb: 2 }}>
            <Typography variant="body2" color="text.secondary" sx={{ flexGrow: 1 }}>
              {folderMeta
                ? `Basis: ${folderMeta.base} • Insgesamt: ${folderMeta.total}`
                : 'Ordnerübersicht'}
            </Typography>
            <Typography variant="body2">Ausgewählt: {selectedFolders.length}</Typography>
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
                disabled={selectedFolders.length === 0 || creatingJobs}
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
