import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: './',
  plugins: [VitePWA({
    registerType: 'autoUpdate',
    injectRegister: null,
    includeAssets: ['favicon.svg'],
    manifest: {
      name: 'Bulls & Cows', short_name: 'Bulls & Cows', description: 'A friendly peer-to-peer code duel.',
      theme_color: '#17231d', background_color: '#f5f6f2', display: 'standalone', start_url: './', scope: './',
      icons: [{ src: './favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
    },
    workbox: { globPatterns: ['**/*.{js,css,html,svg,png,ico}'] },
  }),
  ],
  server: { watch: { ignored: ['**/work/**', '**/outputs/**'] } },
});
