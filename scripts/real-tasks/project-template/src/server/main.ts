import http from 'node:http';
import { handle } from './http.ts';

const port = Number(process.env['PORT'] ?? 3000);
http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : undefined;
    const r = handle(req.method ?? 'GET', req.url ?? '/', body);
    res.writeHead(r.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(r.body));
  });
}).listen(port, () => console.log(`listening on ${port}`));
