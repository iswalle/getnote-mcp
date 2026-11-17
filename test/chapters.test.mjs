import assert from 'node:assert/strict';
import test from 'node:test';
import {chapterEndTimes} from '../dist/chapters.js';
test('chapter end is derived in ms without overwriting server data or input',()=>{
 const input={source:'summary',items:[{start_ms:1000,title:'A'},{start_ms:2000,title:'B'},{start_ms:3000,end_ms:3500,title:'C'},{start_ms:5000,title:'D'}]};
 const result=chapterEndTimes(input);
 assert.equal(result.items[0].end_ms,2000);assert.equal(result.items[0].end_source,'next_chapter_start');
 assert.equal(result.items[2].end_ms,3500);assert.equal(result.items[3].end_ms,null);assert.equal(input.items[0].end_ms,undefined);
 for(const next of [999,1000,'2000',NaN])assert.equal(chapterEndTimes({items:[{start_ms:1000},{start_ms:next}]}).items[0].end_ms,null);
});
