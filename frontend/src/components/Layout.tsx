import React from 'react';
import {
  AppBar,
  Box,
  Button,
  IconButton,
  Container,
  Divider,
  Drawer,
  Grid,
  InputAdornment,
  List,
  ListItemButton,
  ListItemText,
  OutlinedInput,
  Stack,
  Toolbar,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
  useMediaQuery,
} from '@mui/material';
import { Link, useLocation } from 'react-router-dom';
import MenuIcon from '@mui/icons-material/Menu';
import SearchIcon from '@mui/icons-material/Search';
import { alpha, useTheme } from '@mui/material/styles';
import { usePromptNotifications } from '../context/PromptNotifications';
import logoWhite from '../imgs/logo_white.svg';
import logoBlack from '../imgs/logo_black.svg';

interface NavItem {
  label: string;
  to: string;
  highlight?: boolean;
}

const mainNavigation: NavItem[] = [
  { label: 'Dashboard', to: '/' },
  { label: 'Pipeline', to: '/pipeline' },
  { label: 'Analysen', to: '/analyses' },
  { label: 'Historie', to: '/history' },
  { label: 'Tenants', to: '/tenants' },
  { label: 'Prompts', to: '/prompts' },
  { label: 'Settings', to: '/settings' },
];

const quickNavigation: NavItem[] = [
  { label: 'Upload', to: '/upload' },
  { label: 'SharePoint Upload', to: '/ingest' },
  { label: 'Help', to: '/help' },
];

export default function Layout({ children }: { children: React.ReactNode }) {
  const theme = useTheme();
  const { unread } = usePromptNotifications();
  const location = useLocation();
  const isMdUp = useMediaQuery(theme.breakpoints.up('md'));
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [language, setLanguage] = React.useState<'de' | 'en'>('de');
  const logo = theme.palette.mode === 'dark' ? logoWhite : logoBlack;
  const [searchValue, setSearchValue] = React.useState('');

  const handleDrawerToggle = () => setDrawerOpen((prev) => !prev);

  const handleLanguageChange = (
    _: React.MouseEvent<HTMLElement>,
    value: 'de' | 'en' | null,
  ) => {
    if (value) {
      setLanguage(value);
    }
  };

  const renderNavButton = (item: NavItem) => {
    const isActive =
      location.pathname === item.to ||
      (item.to !== '/' && location.pathname.startsWith(item.to));
    return (
      <Button
        key={item.label}
        component={Link}
        to={item.to}
        sx={{
          position: 'relative',
          px: 2,
          py: 1.5,
          borderRadius: 'var(--radius-button)',
          fontWeight: 600,
          fontSize: '0.95rem',
          color: isActive ? theme.palette.primary.main : theme.palette.text.secondary,
          backgroundColor: isActive
            ? alpha(theme.palette.primary.main, 0.1)
            : 'transparent',
          '&:hover': {
            color: theme.palette.primary.main,
            backgroundColor: alpha(theme.palette.primary.main, 0.08),
          },
        }}
      >
        <Stack direction="row" spacing={1} alignItems="center">
          <span>{item.label}</span>
          {item.label === 'Prompts' && unread > 0 && (
            <Box
              sx={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                backgroundColor: theme.palette.info.main,
                boxShadow: `0 0 0 3px ${alpha(theme.palette.info.main, 0.35)}`,
              }}
            />
          )}
        </Stack>
      </Button>
    );
  };

  const drawerContent = (
    <Box sx={{ py: 4, px: 3, display: 'flex', flexDirection: 'column', gap: 3, width: 320 }}>
      <Box sx={{ display: 'flex', justifyContent: 'center' }}>
        <Box component="img" src={logo} alt="Regress logo" sx={{ width: 140 }} />
      </Box>

      <OutlinedInput
        value={searchValue}
        onChange={(event) => setSearchValue(event.target.value)}
        placeholder="Suche"
        fullWidth
        startAdornment={
          <InputAdornment position="start">
            <SearchIcon fontSize="small" />
          </InputAdornment>
        }
      />

      <Divider flexItem>
        <Typography variant="caption" color="text.secondary">
          Navigation
        </Typography>
      </Divider>

      <List sx={{ textTransform: 'none' }}>
        {[...mainNavigation, ...quickNavigation].map((item) => (
          <ListItemButton
            key={item.label}
            component={Link}
            to={item.to}
            selected={location.pathname === item.to}
            onClick={() => setDrawerOpen(false)}
          >
            <ListItemText
              primary={item.label}
              primaryTypographyProps={{
                sx: {
                  fontWeight: 600,
                },
              }}
            />
          </ListItemButton>
        ))}
      </List>

      <Stack direction="row" spacing={1.5} alignItems="center" justifyContent="flex-start">
        <ToggleButtonGroup
          size="small"
          exclusive
          value={language}
          onChange={handleLanguageChange}
          aria-label="Sprachauswahl"
        >
          <ToggleButton value="de" aria-label="Deutsch">
            DE
          </ToggleButton>
          <ToggleButton value="en" aria-label="Englisch">
            EN
          </ToggleButton>
        </ToggleButtonGroup>
      </Stack>

      <Typography variant="caption" color="text.secondary">
        Regress Platform · Zukunftssichere Qualitätsanalysen
      </Typography>
    </Box>
  );

  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: theme.palette.background.default,
      }}
    >
      <AppBar
        position="sticky"
        elevation={0}
        color="inherit"
        sx={{
          backgroundColor: alpha(theme.palette.background.paper, theme.palette.mode === 'dark' ? 0.92 : 0.96),
          backdropFilter: 'blur(18px)',
          borderBottom: `1px solid ${theme.palette.divider}`,
        }}
      >
        <Container maxWidth="lg">
          <Toolbar
            disableGutters
            sx={{
              minHeight: 88,
              alignItems: 'center',
              gap: 3,
              py: { xs: 1, md: 1.5 },
            }}
          >
            <Box
              component={Link}
              to="/"
              sx={{
                display: 'flex',
                alignItems: 'center',
                textDecoration: 'none',
              }}
            >
              <Box component="img" src={logo} alt="Regress logo" sx={{ width: { xs: 120, md: 148 } }} />
            </Box>

            {isMdUp ? (
              <Stack direction="row" spacing={0.5} sx={{ flexGrow: 1 }}>
                {mainNavigation.map(renderNavButton)}
              </Stack>
            ) : (
              <Box sx={{ flexGrow: 1 }} />
            )}

            {isMdUp && (
              <Stack direction="row" spacing={2} alignItems="center">
                <OutlinedInput
                  value={searchValue}
                  onChange={(event) => setSearchValue(event.target.value)}
                  placeholder="Suche"
                  size="small"
                  sx={{
                    width: 220,
                    backgroundColor:
                      theme.palette.mode === 'dark'
                        ? alpha('#0f172a', 0.6)
                        : 'var(--color-bg-alt)',
                  }}
                  startAdornment={
                    <InputAdornment position="start">
                      <SearchIcon fontSize="small" />
                    </InputAdornment>
                  }
                />
                <ToggleButtonGroup
                  value={language}
                  exclusive
                  onChange={handleLanguageChange}
                  size="small"
                  aria-label="Sprachauswahl"
                  sx={{
                    '& .MuiToggleButton-root': {
                      fontWeight: 600,
                      px: 1.5,
                    },
                  }}
                >
                  <ToggleButton value="de">DE</ToggleButton>
                  <ToggleButton value="en">EN</ToggleButton>
                </ToggleButtonGroup>
              </Stack>
            )}

            {!isMdUp && (
              <IconButton
                onClick={handleDrawerToggle}
                aria-label="Navigationsmenü öffnen"
                sx={{
                  backgroundColor: alpha(theme.palette.primary.main, 0.1),
                  color: theme.palette.primary.main,
                }}
              >
                <MenuIcon />
              </IconButton>
            )}
          </Toolbar>
        </Container>
        {isMdUp && (
          <Box sx={{ borderTop: `1px solid ${theme.palette.divider}` }}>
            <Container maxWidth="lg">
              <Stack
                direction="row"
                spacing={1}
                alignItems="center"
                sx={{ py: 1, display: { xs: 'none', md: 'flex' } }}
              >
                {quickNavigation.map((item) => (
                  <Button
                    key={item.label}
                    component={Link}
                    to={item.to}
                    size="small"
                    color="primary"
                    sx={{
                      fontWeight: 600,
                      px: 1.5,
                      py: 0.75,
                    }}
                  >
                    {item.label}
                  </Button>
                ))}
              </Stack>
            </Container>
          </Box>
        )}
      </AppBar>

      <Drawer
        anchor="right"
        open={drawerOpen}
        onClose={handleDrawerToggle}
        ModalProps={{ keepMounted: true }}
        sx={{ display: { xs: 'block', md: 'none' } }}
      >
        {drawerContent}
      </Drawer>

      <Box component="main" sx={{ flexGrow: 1, py: { xs: 5, md: 8 } }}>
        <Container maxWidth="lg">
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: { xs: 4, md: 6 } }}>{children}</Box>
        </Container>
      </Box>

      <Box
        component="footer"
        sx={{
          mt: 'auto',
          py: { xs: 4, md: 6 },
          borderTop: `1px solid ${theme.palette.divider}`,
          backgroundColor: theme.palette.mode === 'dark'
            ? alpha('#0b172a', 0.9)
            : 'var(--color-bg-alt)',
        }}
      >
        <Container maxWidth="lg">
          <Grid container spacing={4} sx={{ pb: { xs: 3, md: 4 } }}>
            <Grid item xs={12} md={4}>
              <Stack spacing={1.5}>
                <Box component={Link} to="/" sx={{ display: 'inline-flex', textDecoration: 'none' }}>
                  <Box component="img" src={logo} alt="Regress logo" sx={{ width: 120 }} />
                </Box>
                <Typography variant="body2" color="text.secondary">
                  Regress – zuverlässige Regressionstests und KI-gestützte Analysen in einem klaren Corporate Layout.
                </Typography>
              </Stack>
            </Grid>
            <Grid item xs={12} sm={6} md={4}>
              <Stack spacing={1.5}>
                <Typography variant="subtitle2" color="text.secondary">
                  Kontakt
                </Typography>
                <Stack spacing={0.5}>
                  <Button component="a" href="mailto:contact@regress.ai" variant="text" color="primary">
                    contact@regress.ai
                  </Button>
                  <Typography variant="body2" color="text.secondary">
                    Tel. +49 231 1234567
                  </Typography>
                </Stack>
              </Stack>
            </Grid>
            <Grid item xs={12} sm={6} md={4}>
              <Stack spacing={1.5}>
                <Typography variant="subtitle2" color="text.secondary">
                  Support
                </Typography>
                <Stack spacing={0.5}>
                  <Typography variant="body2" color="text.secondary">
                    Servicezeiten: Mo–Fr, 8–18 Uhr
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Standort: Dortmund & Remote
                  </Typography>
                </Stack>
              </Stack>
            </Grid>
          </Grid>

          <Divider sx={{ my: 2 }} />

          <Stack
            direction={{ xs: 'column', md: 'row' }}
            spacing={2}
            alignItems={{ xs: 'flex-start', md: 'center' }}
            justifyContent="space-between"
          >
            <Typography variant="caption" color="text.secondary">
              © {new Date().getFullYear()} Regress Platform · Datenschutz · Impressum
            </Typography>
          </Stack>
        </Container>
      </Box>
    </Box>
  );
}
