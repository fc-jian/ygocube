import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
function load(file) {
 const exports = {};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL(file, import.meta.url), 'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2021}}).outputText, {exports, require: () => ({})});
 return exports;
}
const info = load('../lib/cardInfo.ts'), bans = load('../lib/banlist.ts');
test('complete monster subtypes and named rules identity', () => {
 for (const [bit, name] of [[0x80,'仪式'],[0x200,'灵魂'],[0x400,'同盟'],[0x800,'二重'],[0x400000,'卡通'],[0x2000000,'特殊召唤']]) assert(info.typeLabel({type: bit | 1}).includes(name));
 assert.equal(info.typeLabel({type:0x82}), '仪式·魔法');
 assert.equal(info.aliasLine({code:2,alias:1,aliasName:'原卡名'}), '规则同名：原卡名');
 assert.equal(info.aliasLine({code:2,alias:1}), '');
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
