import React from 'react';
import { AppBar, Toolbar, Typography, Drawer, List, ListItem, ListItemText } from '@mui/material';
import { Link } from 'react-router-dom';

const drawerWidth = 240;

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex' }}>
      <AppBar position="fixed" sx={{ zIndex: 1201 }}>
        <Toolbar>
          <Typography variant="h6" noWrap component="div">
            Regress Dashboard
          </Typography>
        </Toolbar>
      </AppBar>
      <Drawer
        variant="permanent"
        sx={{ width: drawerWidth, [`& .MuiDrawer-paper`]: { width: drawerWidth } }}
      >
        <Toolbar />
        <List>
          <ListItem button component={Link} to="/">
            <ListItemText primary="Dashboard" />
          </ListItem>
          <ListItem button component={Link} to="/upload">
            <ListItemText primary="Upload" />
          </ListItem>
          <ListItem button component={Link} to="/prompts">
            <ListItemText primary="Prompts" />
          </ListItem>
        </List>
      </Drawer>
      <main style={{ flexGrow: 1, padding: '80px 24px 24px 24px' }}>
        {children}
      </main>
    </div>
  );
}
