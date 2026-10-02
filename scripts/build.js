#!/usr/bin/env node
import { execSync } from 'child_process';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const publicDir = path.join(rootDir, 'public');
const distDir = path.join(rootDir, 'dist');

console.log('Cleaning dist directory...');
if (fs.existsSync(distDir)) {
  fs.removeSync(distDir);
}

console.log('Building bundled LuminaPlus theme...');
execSync('npm run build --prefix themes/luminaplus', { cwd: rootDir, stdio: 'inherit' });

console.log('Building frontend...');
execSync('npx vite build', { cwd: rootDir, stdio: 'inherit' });

console.log('Copying static assets...');
if (fs.existsSync(publicDir)) {
  fs.copySync(publicDir, distDir, { overwrite: false });
  console.log('Copied all static assets');
}

// 重命名为 dashboard.html，避免 ASSETS 直接拦截首页
const indexHtmlPath = path.join(distDir, 'index.html');
const dashboardHtmlPath = path.join(distDir, 'dashboard.html');
if (fs.existsSync(indexHtmlPath)) {
  fs.renameSync(indexHtmlPath, dashboardHtmlPath);
  console.log('Renamed index.html → dashboard.html');
}

// Identify the exact source deployed with both frontend entry points.
const revision = process.env.GITHUB_SHA || execSync('git rev-parse HEAD', { cwd: rootDir, encoding: 'utf8' }).trim();
const release = { revision, builtAt: new Date().toISOString() };
fs.writeJsonSync(path.join(distDir, 'release.json'), release);
for (const entry of ['dashboard.html', 'themes/luminaplus/index.html']) {
  const file = path.join(distDir, entry);
  const html = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, html.replace('</head>', `<meta name="deployment-revision" content="${revision}">\n</head>`));
}
console.log('Build complete!');
