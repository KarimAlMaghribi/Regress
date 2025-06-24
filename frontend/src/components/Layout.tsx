import React, { useContext } from 'react';
import {
  AppBar, Toolbar, Typography, Drawer, List,
  ListItemButton, ListItemText, IconButton, Box
} from '@mui/material';
import { Link, useLocation } from 'react-router-dom';
import MenuIcon from '@mui/icons-material/Menu';
import DarkModeRoundedIcon from '@mui/icons-material/DarkModeRounded';
import { ColorModeContext } from '../ColorModeContext';
import { motion } from 'framer-motion';

const drawerWidth = 240;

export default function Layout({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(true);
  const { toggle } = useContext(ColorModeContext);
  const location = useLocation();

  const handleDrawer = () => {
    console.log('Toggle drawer', !open);
    setOpen(!open);
  };

  const handleColorMode = () => {
    console.log('Toggle color mode');
    toggle();
  };

  return (
    <Box sx={{ display: 'flex' }}>
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
          <IconButton edge="start" color="inherit" onClick={handleDrawer}>
            <MenuIcon />
          </IconButton>
          <Typography variant="h6" sx={{ flexGrow: 1 }}>Regress</Typography>
          <IconButton color="inherit" onClick={handleColorMode} component={motion.button} whileHover={{ rotate: 20 }}>
            <DarkModeRoundedIcon />
          </IconButton>
        </Toolbar>
      </AppBar>

      <Drawer
        variant="persistent"
        open={open}
        sx={{
          width: drawerWidth,
          [`& .MuiDrawer-paper`]: {
            width: drawerWidth,
            borderRight: 'none',
            backdropFilter: 'blur(12px)',
            backgroundColor: 'rgba(0,0,0,0.25)',
          },
        }}
      >
        <Toolbar />
        <List>
          {[
            { text: 'Upload', to: '/upload' },
            { text: 'Prompts', to: '/prompts' },
            { text: 'Analysis', to: '/analysis' },
          ].map(({ text, to }) => (
            <ListItemButton
              key={text}
              component={motion(Link)}
              to={to}
              selected={location.pathname === to}
              whileHover={{ scale: 1.04 }}
              sx={{ transformOrigin: 'center' }}
            >
              <ListItemText primary={text} />
            </ListItemButton>
          ))}
        </List>
      </Drawer>

      <Box component="main" sx={{ flexGrow: 1, p: 3, mt: 8 }}>
        {children}
      </Box>
    </Box>
  );
}
