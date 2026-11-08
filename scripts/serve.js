import http from 'node:http';
import {readFile, stat} from 'node:fs/promises';
import path from 'node:path';
const root = process.cwd();
const port = Number(process.env.PORT || 4173);
const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.webmanifest':'application/manifest+json','.png':'image/png','.json':'application/json'};
http.createServer(async(req,res)=>{
  try {
    const pathname = decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    let target = path.resolve(root, '.'+pathname);
    if(!target.startsWith(root+path.sep) && target!==root) throw new Error('Path');
    if(pathname.split('/').some(p=>p.startsWith('.') && p.length>1)) throw new Error('Hidden');
    if((await stat(target)).isDirectory()) target=path.join(target,'index.html');
    res.writeHead(200,{'Content-Type':types[path.extname(target)]||'application/octet-stream','Cache-Control':'no-cache'});
    res.end(await readFile(target));
  } catch {res.writeHead(404);res.end('Not found');}
}).listen(port,'127.0.0.1',()=>console.log(`Local: http://127.0.0.1:${port}`));
