import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(() => {
  // No build-time PIN any more.
  //
  // This used to require VITE_DASHBOARD_PIN and refuse to build without it, so a
  // committed fallback could never stand in as "auth". That credential is now
  // retired: the dashboard login is a passkey, which yields an HttpOnly session
  // cookie, and the per-company API key never reaches the bundle. There is
  // consequently no secret to guard at build time.
  return {
    plugins: [react()],
    base: '/dashboard/',
    server: {
      proxy: {
        '/api': {
          target: 'http://localhost:3101',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ''),
        },
        '/gk': {
          target: 'http://localhost:9100',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/gk/, ''),
        },
      },
    },
  }
})
