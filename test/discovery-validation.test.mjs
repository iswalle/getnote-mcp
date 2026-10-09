import test from 'node:test';
import assert from 'node:assert/strict';
import { discoveryContract, verifyDiscovery } from '../dist/discovery.js';

test('discovery normalizes lookup and nanosecond intervals without altering source identity',()=>{
 const c=discoveryContract('notes',{source:'dedao',reference_resource_type:'course_article',reference_resource_id:'9007199254740993',reference_article_url:'https://example.invalid/a?x=1#p',created_from:'2026-10-09T11:00:00.000000001+08:00',created_to:'2026-10-09T03:00:00.000000002Z'});
 assert.equal(c.params.created_from,'2026-10-09T03:00:00.000000001Z');assert.equal(c.params.reference_resource_id,'9007199254740993');assert.equal(c.params.reference_article_url,'https://example.invalid/a?x=1#p');
 const k=discoveryContract('topics',{scope:'BOOKSPACE',query:' 《ＡI 书》 ',author:' “作者” '});assert.equal(k.filters.query,'ai 书');assert.equal(k.filters.author,'作者');
 for(const args of [{created_from:'2026-02-30T00:00:00Z'},{created_from:'2026-10-09T11:00:00'},{page_size:0},{page_size:101},{page:2},{topic_id:'t',page:2,cursor:'x'},{reference_resource_id:'9007199254740993'},{source:'dedao',reference_resource_type:'ebook',reference_resource_id:'9223372036854775808'},{created_from:'2026-10-09T03:00:00.000000002Z',created_to:'2026-10-09T03:00:00.000000001Z'}])assert.throws(()=>discoveryContract('notes',args),JSON.stringify(args));
 assert.throws(()=>discoveryContract('topics',{author:'作者'}));
});

test('new contract fails closed for missing capability, filters, counts and continuation',()=>{
 const c=discoveryContract('notes',{topic_id:'topic-x'});
 const base={meta:{capabilities:['note.filters.v1','pagination.v1','note.reference.v1']},data:{notes:[],applied_filters:{topic_id:'topic-x'},pagination:{mode:'cursor',page:null,page_size:20,returned_count:0,total_count:null,has_more:false,next_cursor:null,next_page:null}}};
 verifyDiscovery(base,c);
 const changes=[x=>delete x.meta,x=>delete x.data.applied_filters,x=>x.data.applied_filters.topic_id='other',x=>x.data.pagination.returned_count=1,x=>delete x.data.pagination.total_count,x=>x.data.pagination.has_more=true,x=>x.data.pagination.next_cursor='stale',x=>x.meta.capabilities=x.meta.capabilities.filter(v=>v!=='note.reference.v1')];
 for(const change of changes){const x=structuredClone(base);change(x);assert.throws(()=>verifyDiscovery(x,c));}
});
