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

const APP_BAR_HEIGHT = 64;
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
    toggle();
  };

  return (
    <Box sx={{ display: 'flex' }}>
      <AppBar
        elevation={0}
        position="fixed"
        sx={{
          height: APP_BAR_HEIGHT,
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

      <Sidebar
        open={open}
        onToggle={handleToggle}
        onClose={() => setOpen(false)}
        isMobile={isMobile}
      />

      <Box
        component="main"
        sx={{
          mt: `${APP_BAR_HEIGHT}px`,
          ml: isMobile ? 0 : open ? `${expandedWidth}px` : `${collapsedWidth}px`,
          p: 3,
          flexGrow: 1,
          transition: 'margin-left 0.2s',
        }}
      >
        {children}
      </Box>
    </Box>
  );
}
