import { createTheme, responsiveFontSizes } from '@mui/material';

export const getDesignTokens = (mode: 'light' | 'dark') => ({
  palette: {
    mode,
    ...(mode === 'light'
      ? {
          background: { default: '#F5F7FA', paper: '#FFFFFF' },
          primary: { main: '#3A86FF' },
        }
      : {
          background: { default: '#14161A', paper: 'rgba(255,255,255,0.05)' },
          primary: { main: '#6C5DD3' },
        }),
    secondary: { main: '#FF6B6B' },
  },
  components: {
    MuiPaper: {
      styleOverrides: {
        root: {
          backdropFilter: 'blur(12px)',
          backgroundImage:
            mode === 'dark'
              ? 'linear-gradient(135deg, rgba(108,93,211,0.08), rgba(58,134,255,0.06))'
              : undefined,
          padding: 24,
          borderRadius: 8,
          boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
        },
      },
    },
    MuiButton: {
      styleOverrides: {
        containedPrimary: {
          background: 'linear-gradient(135deg, #6C5DD3 0%, #3A86FF 100%)',
        },
      },
    },
  },
  typography: {
    h4: { fontSize: '32px', fontWeight: 600 },
    h5: { fontSize: '24px', fontWeight: 600 },
    subtitle2: { fontSize: '14px', fontWeight: 500 },
    body1: { fontSize: '16px' },
  },
});

export const buildTheme = (mode: 'light' | 'dark') =>
  responsiveFontSizes(createTheme(getDesignTokens(mode)));
