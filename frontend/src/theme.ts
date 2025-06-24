import { createTheme, responsiveFontSizes } from '@mui/material';

export const getDesignTokens = (mode: 'light' | 'dark') => ({
  palette: {
    mode,
    ...(mode === 'light'
      ? {
          background: { default: '#F8F9FA', paper: '#FFFFFF' },
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
});

export const buildTheme = (mode: 'light' | 'dark') =>
  responsiveFontSizes(createTheme(getDesignTokens(mode)));
