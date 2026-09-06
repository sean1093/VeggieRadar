import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'path'

// The GitHub Pages sub-path, in one place: the Pages build, the manifest scope,
// the navigation fallback and the board-mirror route all have to agree on it.
const base = '/VeggieRadar/'

// Regenerate the icons below with `./scripts/icons.sh` after changing the mark.

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // `prompt`, not `autoUpdate`: an automatic reload would tear the drawer
      // out of the hands of someone reading a price in front of a stall. The
      // new worker installs, then waits until the user taps 重新整理, so a
      // running app is at most one version behind — never reloaded under them.
      registerType: 'prompt',
      manifest: {
        name: '今日菜價 VeggieRadar',
        short_name: '今日菜價',
        // The app has no router; the hash keeps a home-screen launch on the
        // board even if a deep link ever lands in history.
        start_url: `${base}#/`,
        scope: base,
        display: 'standalone',
        lang: 'zh-Hant',
        background_color: '#faf8f3',
        theme_color: '#faf8f3',
        icons: [
          { src: `${base}icon-192.png`, sizes: '192x192', type: 'image/png' },
          { src: `${base}icon-512.png`, sizes: '512x512', type: 'image/png' },
          // Padded to the 80 % safe zone; a launcher crops this one to its own
          // shape, so the frame is dropped and the paper colour bleeds out.
          { src: `${base}icon-512-maskable.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Every in-app URL is the same document, so any navigation resolves to
        // the precached shell — that is what makes an offline launch render.
        navigateFallback: `${base}index.html`,
        // ...except the static board mirror: answering a JSON request with the
        // HTML shell would hand the fetch a document to parse as a board.
        navigateFallbackDenylist: [/\/data\//],
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // The 78 kB social-card image is fetched by LINE and Facebook crawlers,
        // never by the app; precaching it would spend a fifth of the install
        // budget on bytes no shopper will ever see.
        globIgnores: ['**/og-image.png'],
        runtimeCaching: [
          {
            // The static mirror (#13): serve the cached copy instantly and
            // refresh it in the background — a board a few minutes old is worth
            // far more than a spinner, and the payload carries its own dates.
            urlPattern: new RegExp(`${base}data/board\\.json$`),
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'board-mirror', expiration: { maxEntries: 1 } },
          },
          {
            urlPattern: /^https:\/\/fonts\.(googleapis|gstatic)\.com\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts',
              expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 },
              // Font files come back as opaque cross-origin responses (status 0).
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Never cache the Apps Script Web App. It answers platform errors
            // with an HTML page and HTTP 200, so one bad moment would be stored
            // as "the board" and served forever. The app already has a better
            // fallback for this: the last good board in localStorage.
            urlPattern: /^https:\/\/script\.google\.com\//,
            handler: 'NetworkOnly',
          },
          {
            // Analytics must never be replayed from a cache, and must never
            // keep a page from loading. Offline, this simply fails, silently.
            urlPattern: /^https:\/\/www\.googletagmanager\.com\//,
            handler: 'NetworkOnly',
          },
        ],
      },
    }),
  ],
  base, // Base path for GitHub Pages deployment
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
