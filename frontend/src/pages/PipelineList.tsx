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
  Box,
  Stack,
  Tooltip,
  Chip,
  Typography,
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

type Row = { id: string; name: string; overallScore?: number | null };

function ScoreChip({ score }: { score?: number | null }) {
  if (score == null || Number.isNaN(score)) {
    return <Chip size="small" label="kein Score" variant="outlined" />;
  }

  let color: 'success' | 'warning' | 'error' = 'success';
  let Icon = TrendingUpIcon;

  if (score < 50) {
    color = 'error';
    Icon = TrendingDownIcon;
  } else if (score < 80) {
    color = 'warning';
    Icon = TrendingFlatIcon;
  }

  const label = `${Math.round(score)}%`;
  return <Chip size="small" color={color} icon={<Icon />} label={label} />;
}

function Toolbar({
                   onAdd,
                   onReload,
                 }: {
  onAdd: () => void;
  onReload: () => void;
}) {
  return (
      <GridToolbarContainer sx={{ p: 1, gap: 1 }}>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ flex: 1 }}>
          <ListAltIcon />
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
      field: 'overallScore',
      headerName: 'Score',
      width: 140,
      align: 'center',
      headerAlign: 'center',
      sortable: true,
      renderCell: (params) => <ScoreChip score={params.value as number | null} />,
      valueGetter: (params) =>
          typeof params.row.overallScore === 'number'
              ? params.row.overallScore
              : null,
      sortComparator: (v1, v2) => (v1 ?? -1) - (v2 ?? -1),
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
      <Box>
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
              borderRadius: 2,
              '& .MuiDataGrid-columnHeaders': {
                backgroundColor: 'grey.100',
                borderTopLeftRadius: 8,
                borderTopRightRadius: 8,
              },
              '& .MuiDataGrid-row:hover': {
                backgroundColor: 'action.hover',
              },
              '& .MuiDataGrid-cell:focus, & .MuiDataGrid-cell:focus-within': {
                outline: 'none',
              },
            }}
        />
      </Box>
  );
}
