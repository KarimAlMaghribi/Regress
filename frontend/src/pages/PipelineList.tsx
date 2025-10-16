import { useEffect, useState } from 'react';
import {
  DataGrid,
  GridColDef,
  GridToolbarContainer,
  GridToolbarQuickFilter,
  GridToolbarExport,
} from '@mui/x-data-grid';
import {
  IconButton,
  Button,
  Stack,
  Tooltip,
  Typography,
  Paper,
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import AddIcon from '@mui/icons-material/Add';
import RefreshIcon from '@mui/icons-material/Refresh';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import TrendingUpIcon from '@mui/icons-material/TrendingUp';
import TrendingFlatIcon from '@mui/icons-material/TrendingFlat';
import TrendingDownIcon from '@mui/icons-material/TrendingDown';
import ListAltIcon from '@mui/icons-material/ListAlt';
import { usePipelineStore } from '../hooks/usePipelineStore';
import { useNavigate } from 'react-router-dom';
import PageHeader from '../components/PageHeader';
import { alpha, useTheme } from '@mui/material/styles';

type Row = { id: string; name: string;};

function Toolbar({
                   onAdd,
                   onReload,
                 }: {
  onAdd: () => void;
  onReload: () => void;
}) {
  return (
      <GridToolbarContainer sx={{ p: 1.5, gap: 1.5 }}>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ flex: 1 }}>
          <ListAltIcon fontSize="small" />
          <Typography variant="subtitle1" fontWeight={600}>
            Pipelines
          </Typography>
        </Stack>
        <GridToolbarQuickFilter
            quickFilterParser={(v) =>
                v
                .split(' ')
                .map((x) => x.trim())
                .filter(Boolean)
            }
            placeholder="Suchen (Name, ID)…"
        />
        <GridToolbarExport printOptions={{ disableToolbarButton: true }} />
        <Tooltip title="Liste neu laden">
        <span>
          <IconButton onClick={onReload}>
            <RefreshIcon />
          </IconButton>
        </span>
        </Tooltip>
        <Button startIcon={<AddIcon />} variant="contained" onClick={onAdd}>
          Neue Pipeline
        </Button>
      </GridToolbarContainer>
  );
}

export default function PipelineList() {
  const theme = useTheme();
  const { listPipelines, deletePipeline, createPipeline, confirmIfDirty } =
      usePipelineStore();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const load = async () => {
    try {
      setLoading(true);
      const data = await listPipelines();
      setRows(data ?? []);
    } catch {
      // optional: Snackbar/Toast einbauen
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleNew = async () => {
    const name = window.prompt('Bitte Namen der Pipeline eingeben:');
    if (!name) return;
    try {
      const id = await createPipeline(name);
      navigate('/pipeline/' + id);
    } catch {
      /* noop */
    }
  };

  const handleEdit = (id: string) => {
    if (!confirmIfDirty()) return;
    navigate('/pipeline/' + id);
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm('Pipeline wirklich löschen?')) return;
    await deletePipeline(id);
    load();
  };

  const handleCopyId = async (id: string) => {
    try {
      await navigator.clipboard.writeText(id);
    } catch {
      /* noop */
    }
  };

  const columns: GridColDef<Row>[] = [
    {
      field: 'name',
      headerName: 'Name',
      flex: 1,
      minWidth: 180,
      renderCell: (params) => (
          <Stack direction="row" alignItems="center" spacing={1} sx={{ minWidth: 0 }}>
            <ListAltIcon fontSize="small" />
            <Typography noWrap>{params.value}</Typography>
          </Stack>
      ),
    },
    {
      field: 'id',
      headerName: 'ID',
      flex: 1,
      minWidth: 220,
      renderCell: (params) => (
          <Stack direction="row" alignItems="center" spacing={0.5} sx={{ minWidth: 0 }}>
            <Typography sx={{ fontFamily: 'monospace' }} noWrap>
              {params.value}
            </Typography>
            <Tooltip title="ID kopieren">
              <IconButton
                  size="small"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleCopyId(params.value as string);
                  }}
              >
                <ContentCopyIcon fontSize="inherit" />
              </IconButton>
            </Tooltip>
          </Stack>
      ),
    },
    {
      field: 'actions',
      headerName: 'Aktionen',
      width: 140,
      sortable: false,
      filterable: false,
      align: 'center',
      headerAlign: 'center',
      renderCell: (params) => (
          <Stack direction="row" spacing={0} onClick={(e) => e.stopPropagation()}>
            <Tooltip title="Bearbeiten">
              <IconButton onClick={() => handleEdit(params.row.id)}>
                <EditIcon />
              </IconButton>
            </Tooltip>
            <Tooltip title="Löschen">
              <IconButton onClick={() => handleDelete(params.row.id)}>
                <DeleteIcon />
              </IconButton>
            </Tooltip>
          </Stack>
      ),
    },
  ];

  return (
      <Stack spacing={4}>
        <PageHeader
            title="Pipelines"
            subtitle="Automatisierungen strukturieren, verteilen und überwachen"
            breadcrumb={[{ label: 'Dashboard', to: '/' }, { label: 'Pipeline' }]}
            tone="primary"
            icon={<ListAltIcon />}
            tag={`Gesamt: ${rows.length}`}
            actions={
              <Button variant="contained" startIcon={<AddIcon />} onClick={handleNew}>
                Neue Pipeline
              </Button>
            }
        />

        <Paper
            variant="outlined"
            sx={{
              p: { xs: 3, md: 4 },
              borderRadius: 'var(--radius-card)',
              boxShadow: 'var(--shadow-z1)',
              background:
                  theme.palette.mode === 'dark'
                      ? alpha(theme.palette.primary.main, 0.1)
                      : 'linear-gradient(130deg, rgba(0,110,199,0.08), rgba(247,250,252,0.9))',
            }}
        >
          <Stack spacing={2}>
            <Typography variant="h6" sx={{ fontWeight: 600 }}>
              Portfolio im Blick behalten
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Filtern, exportieren und per Doppelklick direkt in die Detailkonfiguration springen.
              Die Tabelle zeigt alle aktiven Pipelines der Plattform.
            </Typography>
          </Stack>
        </Paper>

        <Paper
            variant="outlined"
            sx={{
              p: { xs: 2, md: 3 },
              borderRadius: 'var(--radius-card)',
              boxShadow: 'var(--shadow-z1)',
            }}
        >
          <DataGrid
              autoHeight
              rows={rows}
              columns={columns}
              getRowId={(r) => r.id}
              loading={loading}
              disableRowSelectionOnClick
              onRowDoubleClick={(p) => handleEdit(p.row.id)}
              slots={{
                toolbar: () => <Toolbar onAdd={handleNew} onReload={load} />,
              }}
              initialState={{
                pagination: { paginationModel: { pageSize: 10, page: 0 } },
                sorting: { sortModel: [{ field: 'name', sort: 'asc' }] },
              }}
              pageSizeOptions={[5, 10, 25, 50]}
              density="compact"
              sx={{
                border: 'none',
                '& .MuiDataGrid-columnHeaders': {
                  backgroundColor: theme.palette.mode === 'dark'
                    ? alpha(theme.palette.primary.main, 0.12)
                    : alpha(theme.palette.primary.main, 0.08),
                  borderTopLeftRadius: 12,
                  borderTopRightRadius: 12,
                  borderBottom: `1px solid ${theme.palette.divider}`,
                },
                '& .MuiDataGrid-row:hover': {
                  backgroundColor: theme.palette.action.hover,
                },
                '& .MuiDataGrid-cell:focus, & .MuiDataGrid-cell:focus-within': {
                  outline: 'none',
                },
              }}
          />
        </Paper>
      </Stack>
  );
}
