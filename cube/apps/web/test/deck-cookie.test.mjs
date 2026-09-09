import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const code=ts.transpileModule(fs.readFileSync(new URL('../components/duel/deck-cookie.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2021}}).outputText;
function harness(blocked=false){
 const cookies=new Map(), document={};
 Object.defineProperty(document,'cookie',{get:()=>[...cookies].map(([k,v])=>`${k}=${v}`).join('; '),set:raw=>{if(blocked)return;const [pair]=raw.split(';'),[k,v]=pair.split('=');if(raw.includes('Max-Age=0'))cookies.delete(k);else cookies.set(k,v)}});
 const exports={};vm.runInNewContext(code,{exports,document,location:{protocol:'http:'},crypto:{randomUUID:()=> '12345678-1234-1234-1234-123456789012'}});return {api:exports,cookies};
}
test('YDK main/extra/side survives cookie save and deletion',()=>{
 const {api,cookies}=harness();const text='#created by test\r\n#main\r\n89631139\r\n89631139\r\n#extra\r\n23995346\r\n!side\r\n32864';
 const d=api.parseYdk(text,'青眼'), id=api.saveDeck(d);
 assert.equal(api.ydk(api.readDecks()[0]),api.ydk(d));
 assert.equal(api.readDecks()[0].name,'青眼');assert.equal(api.readDecks()[0].main.length,2);
 api.deleteDeck(id);assert.equal(cookies.size,0);
});
test('rejected cookie writes and malformed uploads fail visibly',()=>{
 const {api}=harness(true);
 assert.throws(()=>api.saveDeck(api.parseYdk('#main\n123','test')),/浏览器未允许保存/);
 assert.throws(()=>api.parseYdk('#main\nnope','test'),/无效的 YDK/);
 assert.throws(()=>api.parseYdk('#main\n4294967296','test'),/无效的 YDK/);
});
test('full cookie library rejects the new write while preserving old decks',()=>{
 const {api}=harness(),d=api.parseYdk('#main\n123','test');
 for(let i=0;i<8;i++)api.saveDeck(d,i.toString(16).padStart(32,'0'));
 assert.throws(()=>api.saveDeck(d,'f'.repeat(32)),/空间不足/);
 assert.equal(api.readDecks().length,8);
});
