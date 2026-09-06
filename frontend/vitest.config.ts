import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'path'

export default defineConfig({
  // The PWA plugin is here only so `virtual:pwa-register/react` resolves —
  // `disable` keeps it from generating a worker or a manifest for a test run,
  // and the module it serves outside a build is the plugin's own no-op client.
  // The prompt's two states are then driven by `vi.mock` in its test, so the
  // suite never registers a worker or reaches the network.
  plugins: [react(), VitePWA({ disable: true })],
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
