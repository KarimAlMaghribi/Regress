import React from 'react';
import { Typography, Paper } from '@mui/material';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

const data = [
  { name: 'Jan', value: 4 },
  { name: 'Feb', value: 8 },
  { name: 'Mar', value: 3 },
];

export default function Dashboard() {
  return (
    <div>
      <Typography variant="h4" gutterBottom>Overview</Typography>
      <Paper sx={{ height: 300, p: 2 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data}>
            <XAxis dataKey="name" />
            <YAxis />
            <Tooltip />
            <Line type="monotone" dataKey="value" stroke="#1976d2" />
          </LineChart>
        </ResponsiveContainer>
      </Paper>
    </div>
  );
}
