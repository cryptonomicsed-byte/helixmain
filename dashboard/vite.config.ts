import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ command, mode }) => {
  // Refuse to produce a production bundle with no dashboard PIN.
  // A hardcoded fallback committed to git is a documented key, not auth.
  if (command === 'build') {
    const env = loadEnv(mode, process.cwd(), 'VITE_')
    if (!(env.VITE_DASHBOARD_PIN ?? '').trim()) {
      throw new Error(
        '\n\n  VITE_DASHBOARD_PIN is not set — refusing to build.\n' +
        '  A committed fallback PIN is a known key. Set it and rebuild:\n' +
        '      VITE_DASHBOARD_PIN=<pin> npm run build\n\n',
      )
    }
  }

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
