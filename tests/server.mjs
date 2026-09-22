import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const host = '127.0.0.1';
const port = 4173;
const types = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg'
};

const handleRequest = async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, `http://${host}:${port}`).pathname);
    const relative = pathname === '/' ? 'kartenprojektion_prototyp_v2_1.html' : pathname.slice(1);
    const file = resolve(root, relative);
    if (file !== root && !file.startsWith(root + sep)) throw new Error('Pfad außerhalb des Projekts');
    const info = await stat(file);
    if (!info.isFile()) throw new Error('Keine Datei');
    response.writeHead(200, { 'Content-Type': types[extname(file).toLowerCase()] || 'application/octet-stream' });
    createReadStream(file).pipe(response);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Nicht gefunden');
  }
};

export function startServer() {
  return new Promise((resolveStart, rejectStart) => {
    const server = createServer(handleRequest);
    server.once('error', rejectStart);
    server.listen(port, host, () => resolveStart(server));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startServer();
  console.log(`Testserver: http://${host}:${port}`);
}
