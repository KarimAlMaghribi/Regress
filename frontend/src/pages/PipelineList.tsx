import React, { useEffect, useState } from 'react';
import { Box, Table, TableHead, TableRow, TableCell, TableBody, Button } from '@mui/material';
import { useNavigate } from 'react-router-dom';

interface PipelineItem {
  id: string;
  name: string;
  data: any;
}

export default function PipelineList() {
  const [list, setList] = useState<PipelineItem[]>([]);
  const navigate = useNavigate();

  const load = () => {
    fetch('/pipelines')
      .then(r => r.json())
      .then(setList);
  };

  useEffect(load, []);

  const handleDelete = (id: string) => {
    fetch(`/pipelines/${id}`, { method: 'DELETE' }).then(load);
  };

  const handleCopy = (p: PipelineItem) => {
    fetch('/pipelines', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `${p.name} Copy`, data: p.data }),
    }).then(load);
  };

  return (
    <Box>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>Name</TableCell>
            <TableCell>Actions</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {list.map(p => (
            <TableRow key={p.id}>
              <TableCell>{p.name}</TableCell>
              <TableCell>
                <Button size="small" onClick={() => navigate(`/pipeline/${p.id}`)}>Edit ▶️</Button>
                <Button size="small" onClick={() => handleDelete(p.id)}>🗑️ Delete</Button>
                <Button size="small" onClick={() => handleCopy(p)}>📋 Copy</Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Box>
  );
}
