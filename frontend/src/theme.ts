import { alpha, createTheme, darken, responsiveFontSizes } from '@mui/material/styles';

const PRIMARY_COLOR = '#006ec7';

export const getDesignTokens = (mode: 'light' | 'dark') => ({
  palette: {
    mode,
    ...(mode === 'light'
      ? {
          background: { default: '#F5F7FA', paper: '#FFFFFF' },
          primary: { main: PRIMARY_COLOR },
        }
      : {
          background: { default: '#14161A', paper: alpha('#FFFFFF', 0.04) },
          primary: { main: PRIMARY_COLOR },
        }),
    secondary: { main: PRIMARY_COLOR },
  },
  components: {
    MuiPaper: {
      styleOverrides: {
        root: {
          backdropFilter: 'blur(12px)',
          backgroundImage:
            mode === 'dark'
              ? `linear-gradient(135deg, ${alpha(PRIMARY_COLOR, 0.14)}, ${alpha(PRIMARY_COLOR, 0.08)})`
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
          backgroundColor: PRIMARY_COLOR,
          '&:hover': {
            backgroundColor: darken(PRIMARY_COLOR, 0.1),
          },
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
