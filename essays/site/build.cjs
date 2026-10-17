#!/usr/bin/env node
'use strict';

// Build only the published manifest. Drafts and discussion stores are never copied.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const MarkdownIt = require('markdown-it');
const config = require('./config.json');

const root = path.resolve(__dirname, '../..');
const output = path.resolve(process.argv[2] || path.join(root, 'output/rethink-terminal'));
const base = new URL(config.url).pathname;
const template = fs.readFileSync(path.join(__dirname, 'page.html'), 'utf8');
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pages = [{ file: 'README.md', slug: '', number: null }, ...config.essays.map(essay => ({ ...essay, slug: essay.file.replace(/\.md$/, '') }))];
const routes = new Map(pages.map(page => [path.join(root, 'essays', page.file), `${base}${page.slug ? page.slug + '/' : ''}`]));
const assets = new Map();
const diagrams = [];

function asset(file) {
  const relative = path.relative(root, file).split(path.sep).join('/');
  if (relative.startsWith('../') || !fs.statSync(file).isFile()) throw new Error(`Invalid asset: ${file}`);
  const destination = `media/${relative}`;
  assets.set(file, destination);
  return `${base}${destination}`;
}

function rewrite(url, source, image = false) {
  if (!url || url.startsWith('#') || /^(?:mailto:|tel:|data:)/i.test(url)) return url;
  let local = url;
  for (const prefix of [`${config.repository}/blob/main/`, `${config.repository}/raw/main/`, 'https://raw.githubusercontent.com/albertwujj/agent-term/main/']) {
    if (local.startsWith(prefix)) { local = path.relative(path.dirname(source), path.join(root, local.slice(prefix.length))); break; }
  }
  if (/^https?:\/\//i.test(local)) {
    const parsed = new URL(local);
    const site = new URL(config.url);
    if (parsed.origin === site.origin && [...routes.values()].includes(parsed.pathname)) return parsed.pathname + parsed.search + parsed.hash;
    return url;
  }
  const match = local.match(/^([^?#]*)(\?[^#]*)?(#.*)?$/);
  const file = path.resolve(path.dirname(source), decodeURIComponent(match[1]));
  const suffix = (match[2] || '') + (match[3] || '');
  const relative = path.relative(root, file).split(path.sep).join('/');
  if (relative.startsWith('../')) throw new Error(`Link leaves repository: ${url}`);
  if (routes.has(file)) return routes.get(file) + (match[3] || '');
  if (!fs.existsSync(file)) throw new Error(`Missing target in ${source}: ${url}`);
  if (image || /\.(?:png|jpe?g|gif|svg|webp|avif|mp4|webm|json|pdf)$/i.test(file)) return asset(file) + suffix;
  return `${config.repository}/blob/main/${relative}${suffix}`;
}

function slug(text) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s+/g, '-');
}

function render(page) {
  const source = path.join(root, 'essays', page.file);
  const markdown = fs.readFileSync(source, 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '');
  const md = new MarkdownIt({ html: true });
  const fence = md.renderer.rules.fence;
  md.renderer.rules.fence = (tokens, index, options, env, renderer) => {
    if (tokens[index].info.trim() !== 'mermaid') return fence(tokens, index, options, env, renderer);
    const id = `essay-diagram-${diagrams.length + 1}`;
    diagrams.push({ id, code: tokens[index].content, page });
    return `<div class="diagram" data-diagram="${id}"></div>\n`;
  };
  const tokens = md.parse(markdown, {});
  const headings = new Set();
  function visit(list) {
    for (let i = 0; i < list.length; i++) {
      const token = list[i];
      if (token.type === 'heading_open') {
        const stem = slug(list[i + 1].content);
        let id = stem;
        for (let n = 1; headings.has(id); n++) id = `${stem}-${n}`;
        headings.add(id);
        token.attrSet('id', id);
      }
      if (token.type === 'link_open') token.attrSet('href', rewrite(token.attrGet('href'), source));
      if (token.type === 'image') token.attrSet('src', rewrite(token.attrGet('src'), source, true));
      if (token.type === 'html_inline' || token.type === 'html_block') {
        token.content = token.content.replace(/\b(src|href)=(['"])(.*?)\2/g, (_all, name, quote, url) => `${name}=${quote}${escape(rewrite(url, source, name === 'src'))}${quote}`);
      }
      if (token.children) visit(token.children);
    }
  }
  visit(tokens);
  const h1 = tokens.findIndex(token => token.type === 'heading_open' && token.tag === 'h1');
  page.title = tokens[h1 + 1].content;
  const description = tokens.find((token, i) => token.type === 'inline' && i > h1 + 4 && token.content.length > 100)?.content.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*`]/g, '') || config.description;
  page.body = md.renderer.render(tokens, md.options, {});
  page.description = description;
}

function navigation(index) {
  const essays = pages.slice(1);
  const previous = essays[index - 1];
  const next = essays[index + 1];
  const link = (entry, label, cls) => `<a class="${cls}" href="${base}${entry.slug}/"><span>${label}</span>${escape(entry.title)}</a>`;
  return `<nav class="essay-navigation" aria-label="Essay navigation">${previous ? link(previous, '← Previous essay', 'previous') : `<a href="${base}"><span>← Back to</span>The series</a>`}${next ? link(next, 'Next essay →', 'next') : `<a class="next" href="${base}"><span>Back to</span>The series →</a>`}</nav>`;
}

async function main() {
  // Refuse to erase a source directory even when an output argument is mistaken.
  const essayRoot = path.join(root, 'essays');
  if (output === root || root.startsWith(output + path.sep) || output === essayRoot || output.startsWith(essayRoot + path.sep)) throw new Error('Output must be separate from the source tree.');
  if (fs.existsSync(output) && fs.readdirSync(output).length) {
    const marker = path.join(output, 'build.json');
    if (!fs.existsSync(marker) || JSON.parse(fs.readFileSync(marker, 'utf8')).source !== config.repository) throw new Error('Refusing to replace a nonempty directory that is not an essay-site build.');
    fs.rmSync(output, { recursive: true });
  }
  fs.mkdirSync(output, { recursive: true });
  for (const page of pages) render(page);
  if (diagrams.length) {
    const { chromium } = require('playwright-core');
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
      const tab = await browser.newPage();
      await tab.setContent('<!doctype html><html><body></body></html>');
      await tab.addScriptTag({ path: path.join(path.dirname(require.resolve('mermaid/package.json')), 'dist/mermaid.min.js') });
      await tab.evaluate(() => mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'base', fontFamily: 'Arial, sans-serif', themeVariables: { fontSize: '16px', primaryColor: '#e8eeed', primaryTextColor: '#242e36', primaryBorderColor: '#879a9d', lineColor: '#687c83', clusterBkg: '#f0f1ed', clusterBorder: '#c2ccc9' }, flowchart: { htmlLabels: false, useMaxWidth: true } }));
      for (const diagram of diagrams) {
        const svg = await tab.evaluate(async ({ id, code }) => (await mermaid.render(id, code)).svg, { id: diagram.id, code: diagram.code });
        const diagramPath = `assets/diagrams/${diagram.page.slug}-${diagram.id}.svg`;
        const dimensions = svg.match(/viewBox="([^\"]+)"/)[1].split(/\s+/);
        const fullSize = svg.replace(/width="[^\"]+"/, `width="${dimensions[2]}"`);
        fs.mkdirSync(path.join(output, 'assets/diagrams'), { recursive: true });
        fs.writeFileSync(path.join(output, diagramPath), fullSize);
        diagram.page.body = diagram.page.body.replace(`<div class="diagram" data-diagram="${diagram.id}"></div>`, `<div class="diagram"><a href="${base}${diagramPath}" aria-label="Open the diagram at full size">${svg}</a></div>`);
      }
    } finally { await browser.close(); }
  }
  for (const [index, page] of pages.entries()) {
    const canonical = new URL(page.slug ? page.slug + '/' : '', config.url).href;
    const values = { title: escape(page.title), description: escape(page.description), author: escape(config.author), canonical, ogType: page.slug ? 'article' : 'website', base, kind: page.slug ? 'article' : 'landing', repository: config.repository, content: page.body, navigation: page.slug ? navigation(index - 1) : '', source: `${config.repository}/blob/main/essays/${page.file}` };
    const html = template.replace(/\{\{(\w+)\}\}/g, (_all, name) => { if (!(name in values)) throw new Error(`Unknown template field ${name}`); return values[name]; });
    const destination = path.join(output, page.slug);
    fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(path.join(destination, 'index.html'), html);
  }
  for (const [source, relative] of assets) {
    const destination = path.join(output, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
  fs.mkdirSync(path.join(output, 'assets'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'style.css'), path.join(output, 'assets/style.css'));
  fs.writeFileSync(path.join(output, '.nojekyll'), '');
  let commit = 'local-preview';
  try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); } catch {}
  fs.writeFileSync(path.join(output, 'build.json'), JSON.stringify({ source: config.repository, commit, pages: pages.map(page => page.slug || '/') }, null, 2) + '\n');
  fs.writeFileSync(path.join(output, 'README.md'), `# Rethink the terminal: A portal to AI\n\nGenerated website for ${config.url}\n\nEdit the [landing page and essays](${config.repository}/tree/main/essays) in AgentTerm. This repository is a publishing target; its files are replaced automatically.\n\nSource commit: ${commit}\n`);
  console.log(`Built landing page and ${pages.length - 1} finished essays in ${output}; ${assets.size} local assets, ${diagrams.length} static diagrams.`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
