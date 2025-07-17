import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { LocalizationProvider } from '@mui/x-date-pickers';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import { ThemeProvider, CssBaseline } from '@mui/material';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import theme from './theme';

const queryClient = new QueryClient();

const root = createRoot(document.getElementById('root')!);
root.render(
  <QueryClientProvider client={queryClient}>
    <LocalizationProvider dateAdapter={AdapterDayjs}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <App />
      </ThemeProvider>
    </LocalizationProvider>
  </QueryClientProvider>
);
