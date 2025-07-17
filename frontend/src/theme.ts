import { createTheme } from '@mui/material/styles';

const theme = createTheme({
  palette: {
    primary: { main: '#0053B8' },
    secondary: { main: '#FFC61E' },
    error: { main: '#E53935' },
  },
  components: {
    MuiButton: {
      styleOverrides: {
        root: {
          borderRadius: 8,
        },
      },
    },
    MuiTooltip: {
      defaultProps: {
        arrow: true,
      },
    },
  },
});

export default theme;
