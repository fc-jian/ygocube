import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const source=ts.transpileModule(fs.readFileSync(new URL('../lib/pics.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2021}}).outputText;
function setup(files) {
 const exports={};
 vm.runInNewContext(source,{exports,URL:{createObjectURL:file=>`blob:${file.path}`}});
 function dir(prefix='') {return {kind:'directory',getDirectoryHandle:async name=>{
  const next=prefix+name+'/';if(!Object.keys(files).some(p=>p.startsWith(next)))throw Error('NotFound');return dir(next);
 },getFileHandle:async name=>{const path=prefix+name;if(!(path in files))throw Error('NotFound');return {getFile:async()=>({size:files[path],path})}},async *entries(){
  const names=new Set(Object.keys(files).filter(p=>p.startsWith(prefix)).map(p=>p.slice(prefix.length).split('/')[0]));
  for(const name of names)yield [name,{kind:Object.keys(files).some(p=>p.startsWith(prefix+name+'/'))?'directory':'file'}];
 }}}
 return {api:exports,handle:dir()};
}
test('bound YGOPro root automatically resolves expansion-only pictures',async()=>{
 const {api,handle}=setup({'expansions/pics/100200292.jpg':10});
 assert.equal(await api.readCardImageUrl(handle,100200292),'blob:expansions/pics/100200292.jpg');
});
test('expansion PNG overrides base JPG and newly installed art is detected',async()=>{
 const files={'pics/123.jpg':10};const {api,handle}=setup(files);
 assert.equal(await api.readCardImageUrl(handle,123),'blob:pics/123.jpg');
 files['expansions/pics/123.png']=20;
 assert.equal(await api.readCardImageUrl(handle,123),'blob:expansions/pics/123.png');
});
test('pack folders, direct image directories and missing files fall back correctly',async()=>{
 for(const path of ['expansions/pre/pics/123.webp','123.jpeg','pics/123.avif']) {
  const {api,handle}=setup({[path]:12});assert.equal(await api.readCardImageUrl(handle,123),`blob:${path}`);
 }
 const {api,handle}=setup({'expansions/pics/123.jpg':0,'pics/123.jpg':10});
 assert.equal(await api.readCardImageUrl(handle,123),'blob:pics/123.jpg');
 assert.equal(await api.readCardImageUrl(handle,999),null);
});
test('HTTP local roots use the same expansion-first candidate ordering',()=>{
 const {api}=setup({});const paths=api.localCardImagePaths(123);
 assert(paths.indexOf('expansions/pics/123.png')<paths.indexOf('pics/123.jpg'));
});
