import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
test('every SSE open requests state recovery, including reconnect after a lost event', () => {
 const cleanups=[], streams=[], events=[], timers=[];
 const react={useState:()=>[false,()=>{}],useRef:value=>({current:value}),useCallback:f=>f,useEffect:f=>{const c=f();if(c)cleanups.push(c)}};
 class Source {constructor(){streams.push(this)} addEventListener(){} close(){this.closed=true}}
 const exports={};
 const code=ts.transpileModule(fs.readFileSync(new URL('../lib/sse.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2021}}).outputText;
 vm.runInNewContext(code,{exports,require:name=>name==='react'?react:{encodePathSegment:encodeURIComponent},EventSource:Source,setTimeout:f=>{timers.push(f);return timers.length},clearTimeout:()=>{}});
 exports.useTournamentStream('1',{tid:'1',pid:'A',token:'test'},event=>events.push(event));
 streams[0].onopen();streams[0].onerror();assert.equal(streams[0].closed,true);
 timers[0]();streams[1].onopen();assert.deepEqual(events,['reconnect','reconnect']);
 cleanups.forEach(f=>f());assert.equal(streams[1].closed,true);
});
