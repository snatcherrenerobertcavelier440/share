export function openGraphImage(): Response {
  const body = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630"><rect width="1200" height="630" fill="#f6f8fc"/><rect x="70" y="70" width="1060" height="490" rx="32" fill="#fff" stroke="#dde5f0" stroke-width="2"/><text x="126" y="202" font-family="system-ui,-apple-system,sans-serif" font-size="76" font-weight="700" fill="#162a43">Share</text><text x="126" y="270" font-family="system-ui,-apple-system,sans-serif" font-size="31" fill="#587291">Temporary, resumable file transfer</text><text x="126" y="316" font-family="system-ui,-apple-system,sans-serif" font-size="31" fill="#587291">on your own Cloudflare account.</text><rect x="126" y="394" width="250" height="62" rx="14" fill="#0b62d6"/><text x="161" y="435" font-family="system-ui,-apple-system,sans-serif" font-size="23" font-weight="600" fill="#fff">Create a share</text><text x="126" y="503" font-family="system-ui,-apple-system,sans-serif" font-size="20" fill="#587291">Workers · Durable Objects · R2 · Turnstile</text></svg>`;
  return new Response(body, { headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff" } });
}

export function favicon(): Response {
  const body = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="15" fill="#0b62d6"/><path d="M18 40h27a7 7 0 0 0 0-14h-2a12 12 0 0 0-23-2 9 9 0 0 0-2 16Z" fill="#fff"/><path d="M25 34h17" stroke="#0b62d6" stroke-width="3" stroke-linecap="round"/></svg>`;
  return new Response(body, { headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff" } });
}

export function robots(origin: string): Response {
  return new Response(`User-agent: *\nAllow: /$\nDisallow: /share/\nDisallow: /api/\nSitemap: ${origin}/sitemap.xml\n`, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" } });
}

export function sitemap(origin: string): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}/</loc></url></urlset>`, { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600" } });
}
