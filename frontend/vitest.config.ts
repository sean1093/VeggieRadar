import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './setupTests.ts',
    css: true,
    // Force the offline mock board; never hit the network in tests.
    // Pin the timezone to the app's audience: freshness assertions are written
    // in Taipei local time and must not drift on UTC CI runners.
    env: { VITE_API_BASE_URL: '', TZ: 'Asia/Taipei' },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
