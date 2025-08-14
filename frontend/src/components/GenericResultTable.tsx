import React from 'react';
import { DataGrid, GridColDef } from '@mui/x-data-grid';
import { Chip, Button } from '@mui/material';
import { TextPosition } from '../types/pipeline';

interface Props {
  data: any[];
  onSelect?: (pos: TextPosition) => void;
  preferredOrder?: string[];
}

const defaultOrder = [
  'prompt_type',
  'prompt_text',
  'boolean',
  'result',
  'value',
  'weight',
  'route',
  'explanation',
  'error',
];

export default function GenericResultTable({ data, onSelect, preferredOrder = defaultOrder }: Props) {
  const excluded = new Set(['openai_raw', 'openaiRaw', 'json_key', 'jsonKey', 'prompt_id', 'promptId', 'source', 'depth', 'color']);

  const keySet = new Set<string>();
  data.forEach(row => {
    Object.keys(row || {}).forEach(k => {
      if (!excluded.has(k)) keySet.add(k);
    });
  });

  const union = Array.from(keySet);

  const ordered = [
    ...preferredOrder.filter(k => union.includes(k)),
    ...union.filter(k => !preferredOrder.includes(k)).sort(),
  ];

  const columns: GridColDef[] = ordered.map(key => ({
    field: key,
    headerName: key,
    flex: 1,
    valueGetter: params => {
      const v = params.row[key];
      if (v === null || typeof v === 'undefined') return '—';
      if (typeof v === 'object') return JSON.stringify(v);
      return v;
    },
    renderCell: params => {
      if (key === 'boolean' || key === 'result') {
        const v = params.row[key];
        const color = v === true ? 'success' : v === false ? 'error' : undefined;
        const label = v === true ? 'True' : v === false ? 'False' : '—';
        return (
          <Chip size="small" label={label} color={color as any} variant={color ? 'filled' : 'outlined'} />
        );
      }
      if (key === 'route') {
        const depth = params.row.depth || 0;
        const color = params.row.color;
        return (
          <Chip
            size="small"
            label={params.value ?? '—'}
            variant="outlined"
            sx={{ ml: depth * 1, bgcolor: color || undefined }}
          />
        );
      }
      return <>{params.value}</>;
    },
  }));

  columns.push(
    {
      field: 'page',
      headerName: 'page',
      width: 80,
      valueGetter: p => p.row.source?.page ?? '—',
    },
    {
      field: 'quote',
      headerName: 'quote',
      flex: 1,
      valueGetter: p => p.row.source?.quote ?? '—',
    },
    {
      field: 'box',
      headerName: 'box',
      sortable: false,
      width: 110,
      renderCell: params => {
        const src = params.row.source;
        const valid =
          src &&
          typeof src.page === 'number' &&
          Array.isArray(src.bbox) &&
          src.bbox.length === 4 &&
          src.bbox.every((n: any) => typeof n === 'number');
        const handleClick = () => {
          if (valid && onSelect) onSelect({ page: src.page, bbox: src.bbox, quote: src.quote });
        };
        return (
          <Button size="small" onClick={handleClick} disabled={!valid}>
            Box anzeigen
          </Button>
        );
      },
    }
  );

  const rows = data.map((row, i) => ({ id: i, ...row }));

  return (
    <div style={{ width: '100%' }}>
      <DataGrid
        autoHeight
        rows={rows}
        columns={columns}
        disableRowSelectionOnClick
        pageSizeOptions={[5, 10, 25]}
        getRowClassName={params => {
          const v = params.row.boolean ?? params.row.result;
          if (v === true) return 'row-true';
          if (v === false) return 'row-false';
          return '';
        }}
        sx={{
          '& .row-true': { bgcolor: 'success.light' },
          '& .row-false': { bgcolor: 'error.light' },
          '& .MuiDataGrid-virtualScroller': { overflowX: 'auto' },
        }}
      />
    </div>
  );
}
