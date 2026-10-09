import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/dashboard/',
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3101',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
      '/queue': {
        target: 'http://localhost:9100',
        changeOrigin: true,
      },
      '/approve': {
        target: 'http://localhost:9100',
        changeOrigin: true,
      },
      '/deny': {
        target: 'http://localhost:9100',
        changeOrigin: true,
      },
    }
  }
})
