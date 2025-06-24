import React from 'react';
import { Box, Paper, Typography } from '@mui/material';
import { DataGrid, GridColDef } from '@mui/x-data-grid';
import useAnalysisHistory from '../hooks/useAnalysisHistory';
import PageHeader from '../components/PageHeader';

export default function AnalysisHistory() {
  const { data, loading } = useAnalysisHistory({});

  const columns: GridColDef[] = [
    { field: 'id', headerName: 'ID', width: 90 },
    {
      field: 'run_time',
      headerName: 'Run Time',
      flex: 1,
      valueGetter: p => new Date(p.row.run_time).toLocaleString(),
    },
    { field: 'file_name', headerName: 'File', flex: 1 },
    { field: 'prompts', headerName: 'Prompts', flex: 1 },
    { field: 'regress', headerName: 'Regress', type: 'boolean', flex: 0.5 },
  ];

  return (
    <Box>
      <PageHeader
        title="Analysis History"
        breadcrumb={[{ label: 'Dashboard', to: '/' }, { label: 'History' }]}
      />
      <Paper>
        <DataGrid
          autoHeight
          columns={columns}
          rows={data}
          pageSizeOptions={[10, 25, 50]}
          initialState={{ pagination: { paginationModel: { pageSize: 10, page: 0 } } }}
          loading={loading}
        />
        {!loading && data.length === 0 && (
          <Typography sx={{ p: 2 }} align="center">
            Keine Einträge gefunden
          </Typography>
        )}
      </Paper>
    </Box>
  );
}
