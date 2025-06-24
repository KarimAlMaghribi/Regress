import React, { useEffect, useState } from 'react';
import { Typography, Box, Paper, Button } from '@mui/material';
import PageHeader from '../components/PageHeader';
import { LineChart, Line, CartesianGrid, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { motion } from 'framer-motion';

interface MetricPoint {
  timestamp: string;
  accuracy: number;
}

export default function Analysis() {
  const [data, setData] = useState<MetricPoint[]>([]);

  const load = () => {
    console.log('Loading metrics ...');
    fetch('http://localhost:8085/metrics')
      .then(r => r.json())
      .then(d => {
        console.log('Loaded metrics', d.length);
        setData(d);
      })
      .catch(e => console.error('Metrics error', e));
  };

  useEffect(() => { load(); }, []);

  return (
    <Box>
      <PageHeader title="Prompt Analysis" breadcrumb={[{ label: 'Dashboard', to: '/' }, { label: 'Analysis' }]} actions={<Button variant="contained" onClick={load}>Refresh</Button>} />
      <Paper sx={{ p: 2 }}>
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="timestamp" />
            <YAxis />
            <Tooltip />
            <Line type="monotone" dataKey="accuracy" stroke="#6C5DD3" />
          </LineChart>
        </ResponsiveContainer>
      </Paper>
    </Box>
  );
}
