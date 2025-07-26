import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    include: ['zustand', 'zustand/shallow', 'zustand/context'],
  },
  server: {
    port: 3000,
  },
});
