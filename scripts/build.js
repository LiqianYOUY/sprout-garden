import {mkdir,cp,rm} from 'node:fs/promises';
await rm('dist',{recursive:true,force:true});
await mkdir('dist',{recursive:true});
for(const file of ['index.html','src','assets','manifest.webmanifest','sw.js']) await cp(file,`dist/${file}`,{recursive:true});
await cp('index.html','dist/404.html');
console.log('Static site built in dist/');
