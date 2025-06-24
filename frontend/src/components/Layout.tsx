import React, { useContext } from 'react';
import {
  AppBar,
  Toolbar,
  Typography,
  IconButton,
  Box,
  useMediaQuery,
} from '@mui/material';
import { ColorModeContext } from '../ColorModeContext';
import { motion } from 'framer-motion';
import MenuIcon from '@mui/icons-material/Menu';
import DarkModeRoundedIcon from '@mui/icons-material/DarkModeRounded';
import Sidebar from './Sidebar';

const expandedWidth = 240;
const collapsedWidth = 80;

export default function Layout({ children }: { children: React.ReactNode }) {
  const isMobile = useMediaQuery('(max-width:900px)');
  const [open, setOpen] = React.useState(!isMobile);
  const { toggle } = useContext(ColorModeContext);

  React.useEffect(() => {
    setOpen(!isMobile);
  }, [isMobile]);

  const handleToggle = () => {
    setOpen((o) => !o);
  };

  const handleColorMode = () => {
    console.log('Toggle color mode');
    toggle();
  };

  return (
    <Box>
      <AppBar
        elevation={0}
        position="fixed"
        sx={{
          backdropFilter: 'blur(16px)',
          background:
            'linear-gradient(135deg, rgba(108,93,211,0.8), rgba(58,134,255,0.8))',
        }}
      >
        <Toolbar>
          <IconButton edge="start" color="inherit" onClick={handleToggle}>
            <MenuIcon />
          </IconButton>
          <Typography variant="h6" sx={{ flexGrow: 1 }}>
            Regress
          </Typography>
          <IconButton
            color="inherit"
            onClick={handleColorMode}
            component={motion.button}
            whileHover={{ rotate: 20 }}
          >
            <DarkModeRoundedIcon />
          </IconButton>
        </Toolbar>
      </AppBar>

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: `${open ? `repeat(2, ${expandedWidth / 2}px)` : `repeat(2, ${collapsedWidth / 2}px)`} repeat(10, 1fr)`,
          minHeight: '100vh',
          mt: 8,
        }}
      >
        <Sidebar open={open} onToggle={handleToggle} onClose={() => setOpen(false)} />
        <Box component="main" sx={{ gridColumn: 'span 10', p: 3 }}>
          {children}
        </Box>
      </Box>
    </Box>
  );
}
