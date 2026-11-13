import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
function load(file, modules = {}) {
 const exports = {};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL(file, import.meta.url), 'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2021}}).outputText, {exports, require: (name) => modules[name] ?? {}});
 return exports;
}
const shared = load('../../../packages/shared/src/card-search.ts');
const info = load('../lib/cardInfo.ts', {'@ygocube/shared': shared}), bans = load('../lib/banlist.ts');
test('keeps English-quoted card search phrases together', () => {
 assert.deepEqual([...info.cardQueryTokens(' "等级 5"   "RANK 4" 水族  "rank 4" ')], ['等级 5', 'rank 4', '水族']);
});
test('complete monster subtypes and named rules identity', () => {
 for (const [bit, name] of [[0x80,'仪式'],[0x200,'灵魂'],[0x400,'同盟'],[0x800,'二重'],[0x400000,'卡通'],[0x2000000,'特殊召唤']]) assert(info.typeLabel({type: bit | 1}).includes(name));
 assert.equal(info.typeLabel({type:0x82}), '仪式·魔法');
 assert.equal(info.aliasLine({code:2,alias:1,aliasName:'原卡名'}), '规则同名：原卡名');
 assert.equal(info.aliasLine({code:2,alias:1}), '');
 assert.equal(info.aliasLine({code:2,alias:1,aliasName:'原卡名',aliasKind:'artwork'}), '异画版本：原卡名');
 assert.equal(info.statLine({type:0x1000001,level:4,lscale:2,rscale:8}), '等级 4 刻度 2/8');
 assert.equal(info.setNameLine({setNames:['字段甲','字段乙']}), '字段：字段甲|字段乙');
});
test('latest OCG selection and native alias lookup preserve zero', () => {
 const lists=[{id:3,name:'2025.10.01 TCG',limits:{}},{id:9,name:'2025.07.01 OCG',limits:{1:0,2:2}},{id:2,name:'2025.04.01 OCG',limits:{}}];
 assert.equal(bans.latestOcg(lists),9);
 assert.equal(bans.cardLimit(lists[1],{code:2,alias:1}),0);
 assert.equal(bans.cardLimit(lists[1],{code:2}),2);
 assert.equal(bans.cardLimit(lists[1],{code:3}),3);
 assert.equal(bans.latestOcg([]),-1);
});

test('SC is separate from OCG and future OCG lists are not selected by default', () => {
 const lists=[
  {id:0,name:'2027.01.01 OCG',limits:{},format:'OCG',effectiveDate:'2027-01-01'},
  {id:1,name:'2026.10.01 简体中文 / SC',limits:{3679218:0},format:'SC',effectiveDate:'2026-10-01'},
  {id:2,name:'2026.10.01 OCG',limits:{3679218:0},format:'OCG',effectiveDate:'2026-10-01'},
 ];
 assert.equal(bans.latestOcg(lists,'2026-11-12'),2);
 assert.equal(bans.latestOcg(lists,'2027-01-01'),0);
 assert.equal(bans.latestOcg(lists,'2026-09-30'),-1);
 assert.equal(bans.cardLimit(lists[1],{code:Number('03679218')}),0);
 assert.equal(bans.cardLimit(lists[1],{code:3679219,alias:3679218}),0);
});

test('dropdown choices hide identical copies without renumbering native lists', () => {
 const lists=Object.freeze([
  Object.freeze({id:-1,name:'无限制 / Unlimited',limits:{}}),
  Object.freeze({id:7,name:'2026.10.01 OCG',format:'OCG',effectiveDate:'2026-10-01',limits:{3679218:0,123:1}}),
  Object.freeze({id:42,name:'2026.10.01 简体中文 / SC',format:'SC',effectiveDate:'2026-10-01',limits:{3679218:0}}),
  Object.freeze({id:112,name:'2026.10.01 OCG',format:'OCG',effectiveDate:'2026-10-01',limits:{123:1,3679218:0}}),
 ]);
 const choices=bans.banlistChoices(lists);
 assert.deepEqual(Array.from(choices,l=>l.id),[-1,7,42]);
 assert.equal(choices[1],lists[1]);
 assert.equal(bans.cardLimit(choices[1],{code:3679218}),0);
 assert.deepEqual(Array.from(bans.banlistChoices(lists,112),l=>l.id),[-1,112,42]);
 assert.equal(lists.length,4);
});

test('dropdown choices preserve distinct restrictions and formats under the same name', () => {
 const lists=[
  {id:4,name:'Custom',format:'OCG',limits:{123:0}},
  {id:8,name:'Custom',format:'OCG',limits:{123:1}},
  {id:15,name:'Custom',format:'SC',limits:{123:0}},
  {id:23,name:'Custom',format:'OCG',effectiveDate:'2026-10-01',limits:{123:0}},
 ];
 assert.deepEqual(Array.from(bans.banlistChoices(lists),l=>l.id),[4,8,15,23]);
 assert.deepEqual(Array.from(bans.banlistChoices([])),[]);
});
