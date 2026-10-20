import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import wasm from 'vite-plugin-wasm'

// Separate static, client-only build. The normal production PoC is untouched.
export default defineConfig({
  base: './',
  plugins: [wasm(), react()],
  build: {
    outDir: 'build/peerjs-demo',
    rollupOptions: { input: resolve(import.meta.dirname, 'peerjs-demo.html') }
  }
})
