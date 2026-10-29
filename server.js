const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');

const ROOT = fs.realpathSync(__dirname);
const PORT = Number.parseInt(process.env.PORT || '8080', 10);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error('PORT must be a valid TCP port.');
}
const BACKEND_URL = new URL(process.env.AZOLLASENSE_BACKEND_URL || 'http://127.0.0.1:5000');
if (!['http:', 'https:'].includes(BACKEND_URL.protocol) || BACKEND_URL.username || BACKEND_URL.password || BACKEND_URL.pathname !== '/') {
  throw new Error('AZOLLASENSE_BACKEND_URL must be an HTTP(S) origin.');
}
const backendTransport = BACKEND_URL.protocol === 'https:' ? https : http;
const backendAgent = new backendTransport.Agent({ keepAlive: true });
const PUBLIC_FILES = new Set(['login.html', 'manifest.json', 'sw.js']);
const PUBLIC_DIRECTORIES = new Set(['assets', 'css', 'js']);
const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.webp': 'image/webp',
};

function isWithinRoot(filePath) {
  const relative = path.relative(ROOT, filePath);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function isPublicPath(relativePath) {
  const firstSegment = relativePath.split(path.sep)[0];
  return relativePath !== '.' && !relativePath.split(path.sep).some((segment) => segment.startsWith('.')) &&
    (PUBLIC_FILES.has(relativePath) || PUBLIC_DIRECTORIES.has(firstSegment));
}

function sendError(response, status, message) {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(message);
}

function shouldProxy(pathname) {
  return pathname === '/' || pathname === '/login' || pathname === '/index.html' ||
    pathname === '/health' || pathname === '/video_feed' || pathname === '/api' ||
    pathname.startsWith('/api/') || pathname.startsWith('/socket.io/') || pathname.startsWith('/assets/captures/');
}

function proxyToBackend(request, response) {
  const headers = { ...request.headers, host: BACKEND_URL.host };
  if (request.socket.remoteAddress) headers['x-forwarded-for'] = request.socket.remoteAddress;
  headers['x-forwarded-proto'] = request.headers['x-forwarded-proto'] ||
    (request.socket.encrypted ? 'https' : 'http');

  const upstream = backendTransport.request({
    hostname: BACKEND_URL.hostname,
    port: BACKEND_URL.port || (BACKEND_URL.protocol === 'https:' ? 443 : 80),
    path: request.url,
    method: request.method,
    headers,
    agent: backendAgent,
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });

  upstream.on('error', () => {
    if (!response.headersSent) {
      sendError(response, 503, 'AzollaSense backend unavailable. Start app-server.py on port 5000.');
    } else {
      response.destroy();
    }
  });
  request.pipe(upstream);
}

const server = http.createServer((request, response) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  } catch {
    sendError(response, 400, 'Bad Request');
    return;
  }
  if (pathname.includes('\0') || pathname.includes('\\')) {
    sendError(response, 400, 'Bad Request');
    return;
  }
  if (shouldProxy(pathname)) {
    if (!['GET', 'HEAD', 'POST', 'DELETE', 'OPTIONS'].includes(request.method)) {
      response.setHeader('Allow', 'GET, HEAD, POST, DELETE, OPTIONS');
      sendError(response, 405, 'Method Not Allowed');
      return;
    }
    proxyToBackend(request, response);
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD');
    sendError(response, 405, 'Method Not Allowed');
    return;
  }
  if (pathname === '/') pathname = '/index.html';

  const requestedPath = path.resolve(ROOT, `.${pathname}`);
  if (!isWithinRoot(requestedPath)) {
    sendError(response, 403, 'Forbidden');
    return;
  }

  const relativePath = path.relative(ROOT, requestedPath);
  if (!isPublicPath(relativePath)) {
    sendError(response, 404, 'Not Found');
    return;
  }

  fs.realpath(requestedPath, (resolveError, resolvedPath) => {
    if (resolveError) {
      sendError(response, resolveError.code === 'ENOENT' ? 404 : 500,
        resolveError.code === 'ENOENT' ? 'Not Found' : 'Internal Server Error');
      return;
    }
    if (!isWithinRoot(resolvedPath)) {
      sendError(response, 403, 'Forbidden');
      return;
    }
    if (!isPublicPath(path.relative(ROOT, resolvedPath))) {
      sendError(response, 404, 'Not Found');
      return;
    }

    fs.stat(resolvedPath, (statError, stats) => {
      if (statError || !stats.isFile()) {
        sendError(response, statError?.code === 'ENOENT' || !statError ? 404 : 500,
          statError?.code === 'ENOENT' || !statError ? 'Not Found' : 'Internal Server Error');
        return;
      }

      const headers = {
        'Cache-Control': 'no-cache',
        'Content-Length': stats.size,
        'Content-Type': MIME_TYPES[path.extname(resolvedPath).toLowerCase()] || 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
      };
      if (request.method === 'HEAD') {
        response.writeHead(200, headers);
        response.end();
        return;
      }

      fs.createReadStream(resolvedPath)
        .on('error', () => {
          if (!response.headersSent) sendError(response, 500, 'Internal Server Error');
          else response.destroy();
        })
        .on('open', () => response.writeHead(200, headers))
        .pipe(response);
    });
  });
});

server.listen(PORT, () => {
  console.log(`AzollaSense app server running at http://localhost:${PORT}/ (backend: ${BACKEND_URL.origin})`);
});
