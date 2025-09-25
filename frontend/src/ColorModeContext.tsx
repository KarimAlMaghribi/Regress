import React, { createContext, useMemo, useState } from 'react';
import { ThemeProvider, CssBaseline } from '@mui/material';
import { buildTheme } from './theme';

export const ColorModeContext = createContext({ toggle: () => {} });

export default function ColorModeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setMode] = useState<'light' | 'dark'>('light');
  const colorMode = useMemo(
    () => ({ toggle: () => setMode((p) => (p === 'light' ? 'dark' : 'light')) }),
    []
  );
  return (
    <ColorModeContext.Provider value={colorMode}>
      <ThemeProvider theme={buildTheme(mode)}>
        <CssBaseline />
        {children}
      </ThemeProvider>
    </ColorModeContext.Provider>
  );
}
