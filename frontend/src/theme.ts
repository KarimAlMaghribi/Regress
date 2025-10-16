import { alpha, createTheme, responsiveFontSizes } from '@mui/material/styles';

const COLOR_PRIMARY = '#006EC7';
const COLOR_PRIMARY_HOVER = '#0056A9';
const COLOR_LINK = '#006EC7';
const COLOR_TEXT = '#0A0A0A';
const COLOR_TEXT_MUTED = '#475467';
const COLOR_BACKGROUND = '#FFFFFF';
const COLOR_BACKGROUND_ALT = '#F7FAFC';
const COLOR_BORDER = '#E6EAF0';
const COLOR_FOCUS = '#0056A9';

const FONT_SANS = 'Inter, system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

const SHADOW_Z1 = '0 1px 2px rgba(15, 23, 42, 0.08)';
const SHADOW_Z2 = '0 4px 12px rgba(15, 23, 42, 0.12)';

export const getDesignTokens = (mode: 'light' | 'dark') => {
  const isLight = mode === 'light';

  return {
    breakpoints: {
      values: {
        xs: 0,
        sm: 600,
        md: 900,
        lg: 1200,
        xl: 1440,
      },
    },
    palette: {
      mode,
      primary: {
        main: COLOR_PRIMARY,
        dark: COLOR_PRIMARY_HOVER,
        contrastText: '#FFFFFF',
      },
      secondary: {
        main: '#003E7E',
        contrastText: '#FFFFFF',
      },
      info: {
        main: '#2F8AF5',
      },
      text: isLight
        ? {
            primary: COLOR_TEXT,
            secondary: COLOR_TEXT_MUTED,
          }
        : {
            primary: '#F9FAFB',
            secondary: alpha('#F9FAFB', 0.72),
          },
      background: isLight
        ? {
            default: COLOR_BACKGROUND,
            paper: '#FFFFFF',
          }
        : {
            default: '#0B1729',
            paper: '#13213B',
          },
      divider: isLight ? COLOR_BORDER : alpha('#94A3B8', 0.4),
    },
    shape: {
      borderRadius: 12,
    },
    spacing: 8,
    typography: {
      fontFamily: FONT_SANS,
      h1: {
        fontSize: '2.75rem',
        lineHeight: 1.15,
        fontWeight: 700,
      },
      h2: {
        fontSize: '2.25rem',
        lineHeight: 1.2,
        fontWeight: 600,
      },
      h3: {
        fontSize: '1.75rem',
        lineHeight: 1.25,
        fontWeight: 600,
      },
      h4: {
        fontSize: '1.5rem',
        lineHeight: 1.3,
        fontWeight: 600,
      },
      h5: {
        fontSize: '1.25rem',
        lineHeight: 1.3,
        fontWeight: 600,
      },
      body1: {
        fontSize: '1rem',
        lineHeight: 1.6,
        fontWeight: 400,
      },
      body2: {
        fontSize: '0.95rem',
        lineHeight: 1.55,
        fontWeight: 400,
      },
      subtitle1: {
        fontSize: '1.125rem',
        lineHeight: 1.45,
        fontWeight: 500,
      },
      subtitle2: {
        fontSize: '0.875rem',
        lineHeight: 1.5,
        fontWeight: 500,
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
      },
      caption: {
        fontSize: '0.8125rem',
        lineHeight: 1.5,
      },
    },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          ':root': {
            '--color-primary': COLOR_PRIMARY,
            '--color-primary-600': COLOR_PRIMARY_HOVER,
            '--color-link': COLOR_LINK,
            '--color-text': COLOR_TEXT,
            '--color-text-muted': COLOR_TEXT_MUTED,
            '--color-bg': COLOR_BACKGROUND,
            '--color-bg-alt': COLOR_BACKGROUND_ALT,
            '--color-border': COLOR_BORDER,
            '--color-focus': COLOR_FOCUS,
            '--radius-button': '6px',
            '--radius-card': '12px',
            '--shadow-z1': SHADOW_Z1,
            '--shadow-z2': SHADOW_Z2,
          },
          body: {
            backgroundColor: isLight ? COLOR_BACKGROUND : '#0B1729',
            color: isLight ? COLOR_TEXT : '#F9FAFB',
          },
          a: {
            color: 'inherit',
          },
        },
      },
      MuiContainer: {
        styleOverrides: {
          root: {
            paddingLeft: 16,
            paddingRight: 16,
            '@media (min-width:600px)': {
              paddingLeft: 24,
              paddingRight: 24,
            },
          },
        },
      },
      MuiPaper: {
        styleOverrides: {
          root: {
            borderRadius: 'var(--radius-card)',
            border: `1px solid ${isLight ? COLOR_BORDER : alpha('#1E293B', 0.8)}`,
            boxShadow: isLight ? SHADOW_Z1 : '0 10px 25px rgba(0,0,0,0.3)',
            backgroundImage: 'none',
          },
        },
      },
      MuiCard: {
        styleOverrides: {
          root: {
            borderRadius: 'var(--radius-card)',
            border: `1px solid ${isLight ? COLOR_BORDER : alpha('#1E293B', 0.8)}`,
            boxShadow: isLight ? SHADOW_Z1 : '0 10px 25px rgba(0,0,0,0.3)',
          },
        },
      },
      MuiButton: {
        styleOverrides: {
          root: {
            borderRadius: 'var(--radius-button)',
            textTransform: 'none',
            fontWeight: 600,
            transition: 'all 180ms ease',
            '&:focus-visible': {
              outline: `2px solid ${COLOR_FOCUS}`,
              outlineOffset: 2,
            },
          },
          containedPrimary: {
            backgroundColor: COLOR_PRIMARY,
            boxShadow: SHADOW_Z2,
            '&:hover': {
              backgroundColor: COLOR_PRIMARY_HOVER,
              boxShadow: SHADOW_Z2,
            },
          },
          containedSecondary: {
            boxShadow: SHADOW_Z2,
          },
          outlined: {
            borderColor: COLOR_BORDER,
            '&:hover': {
              borderColor: COLOR_PRIMARY,
              backgroundColor: alpha(COLOR_PRIMARY, 0.04),
            },
          },
          textPrimary: {
            color: COLOR_LINK,
            '&:hover': {
              color: COLOR_PRIMARY_HOVER,
              backgroundColor: alpha(COLOR_PRIMARY, 0.08),
            },
          },
        },
      },
      MuiLink: {
        styleOverrides: {
          root: {
            color: COLOR_LINK,
            fontWeight: 500,
            textDecorationColor: alpha(COLOR_LINK, 0.4),
            textUnderlineOffset: 4,
            transition: 'color 150ms ease',
            '&:hover': {
              color: COLOR_PRIMARY_HOVER,
              textDecoration: 'underline',
            },
          },
        },
      },
      MuiIconButton: {
        styleOverrides: {
          root: {
            borderRadius: 999,
            '&:focus-visible': {
              outline: `2px solid ${COLOR_FOCUS}`,
              outlineOffset: 2,
            },
          },
        },
      },
      MuiOutlinedInput: {
        styleOverrides: {
          root: {
            borderRadius: 'var(--radius-button)',
            '& fieldset': {
              borderColor: COLOR_BORDER,
            },
            '&:hover fieldset': {
              borderColor: alpha(COLOR_PRIMARY, 0.6),
            },
            '&.Mui-focused fieldset': {
              borderColor: COLOR_PRIMARY,
              boxShadow: `0 0 0 1px ${alpha(COLOR_PRIMARY, 0.15)}`,
            },
          },
        },
      },
      MuiDrawer: {
        styleOverrides: {
          paper: {
            backgroundColor: isLight ? '#FFFFFF' : '#101B2F',
            backgroundImage: 'none',
            borderLeft: isLight ? `1px solid ${COLOR_BORDER}` : 'none',
          },
        },
      },
      MuiListItemButton: {
        styleOverrides: {
          root: {
            borderRadius: 'var(--radius-button)',
            '&.Mui-selected': {
              backgroundColor: alpha(COLOR_PRIMARY, 0.12),
              color: COLOR_PRIMARY,
            },
          },
        },
      },
    },
  };
};

export const buildTheme = (mode: 'light' | 'dark') =>
  responsiveFontSizes(createTheme(getDesignTokens(mode)));
