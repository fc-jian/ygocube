import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const source=fs.readFileSync(new URL('../components/duel/presentation.ts',import.meta.url),'utf8');
const exports={};vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2021}}).outputText,{exports});
test('native triggered/replacement effect templates receive location and exact card name',()=>{
 const prompt={message:12,hint:221,choices:[{code:123,ref:{player:0,location:4,sequence:0}}]};
 const strings={221:'是否在[%ls]发动[%ls]的诱发类效果？',95:'是否使用[%ls]的效果？',200:'是否在[%ls]发动[%ls]的效果？'};
 assert.equal(exports.effectQuestion(prompt,strings,()=> '测试卡',()=> '怪兽区'),'是否在[怪兽区]发动[测试卡]的诱发类效果？');
 assert.equal(exports.effectQuestion({...prompt,hint:95},strings,()=> '测试卡',()=> '怪兽区'),'是否使用[测试卡]的效果？');
 assert.equal(exports.effectQuestion({...prompt,hint:0},strings,()=> '测试卡',()=> '怪兽区'),'是否在[怪兽区]发动[测试卡]的效果？');
 assert.equal(exports.formatSystemText('%ls / %d',['卡'], '选择效果'),'选择效果');
 assert.equal(exports.formatSystemText('%2$ls %1$d %%',[3,'卡']),'卡 3 %');
});
test('same-name cards keep separate wire actions, including multiple effects on one card',()=>{
 const a={player:0,location:2,sequence:0},b={...a,sequence:1};
 const choices=[{ref:a,code:111,value:0},{ref:a,code:111,value:3},{ref:b,code:111,value:65536},{ref:b,code:111,value:65539},{ref:b,code:111,value:5,description:1},{ref:b,code:111,value:65541,description:2}];
 assert.deepEqual(Array.from(exports.cardActions({choices},b),c=>c.value),[65536,65539,5,65541]);
 assert.equal(exports.cardActions({choices},null).length,0);
 assert(exports.sameCard({...a,sub:8},a),'non-overlay fourth byte can be position');
 assert(!exports.sameCard({...a,location:128,sub:0},{...a,location:128,sub:1}));
});
test('visual events preserve host chain order and card identity',()=>{
 const state={chain:[{index:1,code:111},{index:2,code:222}]};
 const events=[70,71,72,73,72,73,74].map((m,i)=>exports.duelEffect(state,new Uint8Array([0,0,1,m,i<4?2:1])));
 assert.deepEqual(events.map(e=>e.kind),['activate','formed','resolve','solved','resolve','solved','end']);
 assert.equal(events[2].code,222);assert.equal(events[4].code,111);
 assert.equal(exports.duelEffect(state,new Uint8Array([0,0,1,90])),null);
});

test('public target choices resolve exact face-up entities without exposing hidden opponent cards',()=>{
 const card={player:1,location:4,sequence:2,code:123,position:1};
 const state={cards:[card]};const choice={ref:{player:1,location:4,sequence:2}};
 assert.equal(exports.publicChoiceCode(choice,state,0),123);
 assert.equal(exports.publicChoiceCode(choice,{cards:[{...card,position:2}]},0),0);
 assert.equal(exports.publicChoiceCode({ref:{...choice.ref,sequence:1}},state,0),0);
 assert.equal(exports.chainMatches({code:123,ref:{player:0,location:16,sequence:0},originRef:choice.ref},card),true);
 assert.equal(exports.chainMatches({code:456,ref:{player:0,location:16,sequence:0},originRef:choice.ref},card),false);
});
test('a hand activation moved to grave never marks another copy in its former hand slot',()=>{
 const source={player:0,location:16,sequence:0,code:123};
 const otherCopy={player:0,location:2,sequence:0,code:123};
 const link={code:123,ref:source,originRef:otherCopy};
 assert.equal(exports.chainMatches(link,otherCopy,{cards:[source,otherCopy]}),false);
 assert.equal(exports.chainMatches(link,source,{cards:[source,otherCopy]}),true);
});

test('overlay choices resolve each public material by its sub-index, preserving unknown entries',()=>{
 const host={player:1,location:4,sequence:2,code:123,position:1,materials:[222,333,0]};
 const state={cards:[host]};
 const choice=sub=>({ref:{player:1,location:132,sequence:2,sub}});
 assert.equal(exports.publicChoiceCode(choice(0),state,0),222);
 assert.equal(exports.publicChoiceCode(choice(1),state,0),333);
 assert.equal(exports.publicChoiceCode(choice(2),state,0),0);
 assert.equal(exports.publicChoiceCode(choice(3),state,0),0);
 assert.equal(exports.publicChoiceCode({...choice(0),ref:{...choice(0).ref,sequence:3}},state,0),0);
});
