import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// BACKEND_URL lets the dev server talk to another backend (e.g. a throwaway test instance) without editing this file.
const backend = process.env.BACKEND_URL ?? 'http://localhost:4000';

export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': backend, '/socket.io': { target: backend, ws: true }, '/stt': { target: backend, ws: true } } },
});
