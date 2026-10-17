# Publish the essay series

The series is maintained in this repository. [`../README.md`](../README.md) is
both the GitHub essay index and the website's landing-page source. The individual
essay files keep their existing paths, so links shared before the website still
work.

`config.json` explicitly lists the finished essays to publish. A draft is never
included just because its Markdown file exists. When an essay is ready, add it to
that list and link its title from the landing page. Page titles and article bodies
come from the Markdown rather than a second maintained copy.

## Build and preview

The site has its own small dependency installation, separate from Electron and
the terminal's native modules. Use Node.js 24 and an installed Google Chrome:

```sh
npm ci --ignore-scripts --prefix essays/site
npm run build --prefix essays/site
python3 -m http.server 8000 --bind 127.0.0.1 --directory output
```

The build defaults to `output/rethink-terminal`.
Open `http://localhost:8000/rethink-terminal/`. The build renders Mermaid diagrams
to static SVG, copies the referenced media, and rewrites essay-to-essay links for
the site. Links to other Markdown documents continue to GitHub. Reading a page
requires no JavaScript or third-party font or diagram requests.

## Publishing

`.github/workflows/publish-essays.yml` builds the site when the essay sources,
their media, or the workflow change on `main`. It publishes only generated files
to `yunxin/rethink-terminal`, preserving
`https://yunxin.github.io/rethink-terminal/`. That repository is a publishing
target; its old Jekyll sources are replaced by the generated site.

The workflow uses the `ESSAY_SITE_DEPLOY_KEY` repository secret, paired with a
write-enabled deploy key limited to `yunxin/rethink-terminal`. No personal access
token is needed. GitHub Pages continues publishing the root of that repository's
`main` branch; the build's `.nojekyll` file makes it serve the generated HTML.

For a manual rebuild:

```sh
gh workflow run publish-essays.yml --repo albertwujj/agent-term
```
