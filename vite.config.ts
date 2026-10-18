import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    // Keep HMR reliable when the workspace is edited by external tools or
    // hosted on a filesystem where native change notifications are missed.
    watch: { usePolling: true, interval: 500 },
  },
  build: {
    chunkSizeWarningLimit: 520,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/node_modules/pixi.js/')) return 'pixi-core'
          if (id.includes('/node_modules/@pixi/')) return 'pixi-modules'
          if (id.includes('/node_modules/matter-js/')) return 'matter-vendor'
          if (id.includes('/node_modules/react/') || id.includes('/node_modules/react-dom/') || id.includes('/node_modules/scheduler/')) return 'react-vendor'
        },
      },
    },
  },
})
