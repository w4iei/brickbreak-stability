import { defineConfig, type Plugin } from 'vite';

// Offline (`npm run dev`): /api goes to the local audio server (server/server.py), which renders as you play.
// `--mode site` builds the public site (klavecimbel.com/brickbreak) instead: under /brickbreak/, with the pre-rendered
// audio in site/public (site/export.py, site/envelopes.py), into site/dist for Cloudflare (site/wrangler.jsonc).

// The page's title and link preview (WhatsApp, iMessage, socials read the HTML, not the script).
const SITE_URL = 'https://klavecimbel.com/brickbreak/';
const SITE_TITLE = 'Brick Breaker × Stable Audio';
const SITE_DESCRIPTION = 'Music by Yana Kunakbaeva. Hit a brick and the song turns into that emotion.';
const siteHead: Plugin = {
  name: 'site-head',
  transformIndexHtml: (html) =>
    html.replace(
      /<title>.*<\/title>/,
      [
        `<title>${SITE_TITLE}</title>`,
        `<meta name="description" content="${SITE_DESCRIPTION}" />`,
        `<meta property="og:type" content="website" />`,
        `<meta property="og:url" content="${SITE_URL}" />`,
        `<meta property="og:title" content="${SITE_TITLE}" />`,
        `<meta property="og:description" content="${SITE_DESCRIPTION}" />`,
        `<meta property="og:image" content="${SITE_URL}og.png?v=4" />`, // ?v: a new image is fetched afresh, not from previews' caches
        `<meta property="og:image:width" content="1200" />`,
        `<meta property="og:image:height" content="630" />`,
        `<meta name="twitter:card" content="summary_large_image" />`,
      ].join('\n    '),
    ),
};

export default defineConfig(({ mode }) =>
  mode === 'site'
    ? {
        base: '/brickbreak/',
        publicDir: 'site/public',
        plugins: [siteHead],
        build: { outDir: 'site/dist/brickbreak', emptyOutDir: true },
      }
    : {
        publicDir: 'site/public', // the share card's QR code
        server: { proxy: { '/api': process.env.BRICKBREAK_API ?? 'http://127.0.0.1:8765' } }, // another port: BRICKBREAK_API
      },
);
