// The light SVG is the source for both themes; edit its geometry and palettes.
// Run: node scripts/build-diagram-dark.js [path/to/diagram.svg ...]
const fs = require('node:fs');
const path = require('node:path');

const files = process.argv.slice(2);
if (!files.length) files.push('docs/assets/architecture.svg');
for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  if (!/^<svg\b[^>]*\bdata-theme="light"/.test(source)) {
    throw new Error(`Expected an SVG with data-theme="light": ${file}`);
  }
  const destination = file.replace(/\.svg$/, '-dark.svg');
  if (destination === file) throw new Error(`Expected an .svg path: ${file}`);
  const comment = `<!-- Generated from ${path.basename(file)} by scripts/build-diagram-dark.js. -->\n`;
  fs.writeFileSync(destination, comment + source.replace('data-theme="light"', 'data-theme="dark"'));
  console.log(destination);
}
