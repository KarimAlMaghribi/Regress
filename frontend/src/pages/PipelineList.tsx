import { useEffect, useState } from 'react';
import { DataGrid, GridColDef } from '@mui/x-data-grid';
import { IconButton, Button, Box } from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import AddIcon from '@mui/icons-material/Add';
import { usePipelineStore } from '../hooks/usePipelineStore';
import { useNavigate } from 'react-router-dom';

export default function PipelineList() {
  const { listPipelines, deletePipeline, createPipeline, confirmIfDirty } = usePipelineStore();
  const [rows, setRows] = useState<Array<{id:string;name:string}>>([]);
  const navigate = useNavigate();

  const load = () => listPipelines().then(setRows).catch(() => {});
  // call load on mount without returning the Promise as a cleanup function
  useEffect(() => {
    load();
  }, []);

  const handleNew = async () => {
    const name = window.prompt('Name eingeben');
    if (!name) return;
    try {
      const id = await createPipeline(name);
      navigate('/pipeline/' + id);
    } catch {}
  };

  const handleEdit = (id: string) => {
    if (!confirmIfDirty()) return;
    navigate('/pipeline/' + id);
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm('Pipeline wirklich l\u00f6schen?')) return;
    await deletePipeline(id);
    load();
  };

  const columns: GridColDef[] = [
    { field: 'name', headerName: 'Name', flex: 1 },
    { field: 'id', headerName: 'ID', flex: 1 },
    {
      field: 'actions',
      headerName: 'Aktionen',
      sortable: false,
      renderCell: (params) => (
        <>
          <IconButton onClick={() => handleEdit(params.row.id)}><EditIcon /></IconButton>
          <IconButton onClick={() => handleDelete(params.row.id)}><DeleteIcon /></IconButton>
        </>
      )
    }
  ];

  return (
    <Box>
      <Button startIcon={<AddIcon />} onClick={handleNew} sx={{ mb: 1 }}>Neu</Button>
      <DataGrid autoHeight rows={rows} columns={columns} getRowId={r => r.id} />
    </Box>
  );
}
