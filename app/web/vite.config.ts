import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

export default defineConfig({
  plugins: [react()],
  // 原型的 CSS 里没有任何相对资源引用，构建产物可以放在任意子路径下
  base: './',
  resolve: {
    alias: {
      '@app/domain': path.join(repoRoot, 'app/domain/src/index.ts'),
      '@app/shared': path.join(repoRoot, 'app/shared/src/index.ts')
    }
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      // Step 4 接真实 API 时用；Step 3 的数据来自离线 fixture，代理仅作预留
      '/api': { target: 'http://127.0.0.1:5174', changeOrigin: false }
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false
  }
});
