import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  envPrefix: ['VITE_', 'REACT_APP_'],
  optimizeDeps: {
    include: ['zustand', 'zustand/shallow', 'zustand/context'],
  },
  server: {
    port: 3000,
  },
});
