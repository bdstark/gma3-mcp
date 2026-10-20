// SPDX-License-Identifier: MIT
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {official,verdict,eligible,receipt,main}=require('./controller.cjs');
const head='a'.repeat(40),base='b'.repeat(40);
const state={commit_sha:head,status:'completed',has_any_findings:false,has_unresolved_findings:false};
const comment=(code=state,security={commit_sha:null},user={login:'chatgpt-codex-connector',type:'Bot'})=>({id:1,user,body:`<!-- codex-review-state:v1 ${JSON.stringify({code_review:code,security_review:security})} -->`});
test('only a completed clean official review for this head counts',()=>{
 assert.equal(official([comment()],head),true);
 for(const patch of [{commit_sha:base},{status:'running'},{has_any_findings:true},{has_unresolved_findings:true},{has_any_findings:null}]) assert.equal(official([comment({...state,...patch})],head),false);
 assert.equal(official([comment(state,{...state,status:'running'})],head),false);
 assert.equal(official([comment(state,state)],head),true);
 assert.equal(official([comment(state,{}, {login:'bdstark',type:'User'})],head),false);
 assert.equal(official([{...comment(),body:'<!-- codex-review-state:v1 nope -->'}],head),false);
 assert.equal(official([comment(),{...comment({...state,status:'running'}),id:2}],head),false);
});
test('independent verdict fails closed on stale, malformed and contradictory results',()=>{
 const v={head_sha:head,base_sha:base,verdict:'ready',summary:'Done',findings:[]};
 assert.equal(verdict(JSON.stringify(v),head,base).verdict,'ready');
 for(const bad of ['not json',JSON.stringify({...v,head_sha:base}),JSON.stringify({...v,base_sha:head}),JSON.stringify({...v,verdict:'ok'}),JSON.stringify({...v,findings:[{priority:2,path:'src/a.rs',line:1,title:'bug',body:'scenario'}]})]) assert.throws(()=>verdict(bad,head,base));
 assert.equal(verdict(JSON.stringify({...v,verdict:'incomplete'}),head,base).verdict,'incomplete');
});
test('automation excludes forks, drafts, non-owner PRs and stacked bases',()=>{
 const p={state:'open',draft:false,user:{login:'bdstark'},head:{sha:head,repo:{full_name:'bdstark/gma3-mcp'}},base:{ref:'main',sha:base}};
 assert.equal(eligible(p,'bdstark/gma3-mcp'),true);
 for(const x of [{draft:true},{state:'closed'},{user:{login:'outsider'}},{base:{...p.base,ref:'feature'}},{head:{...p.head,repo:{full_name:'fork/repo'}}}]) assert.equal(eligible({...p,...x},'bdstark/gma3-mcp'),false);
});
test('receipts bind bot identity, head and base',()=>{
 const rv={user:{login:'github-actions[bot]',type:'Bot'},commit_id:head,body:`<!-- independent-review:v1 ${JSON.stringify({head,base,verdict:'ready',run:1})} -->`};
 assert.equal(receipt(rv,head,base).run,1);
 assert.equal(receipt(rv,head,head),null);
 assert.equal(receipt({...rv,user:{login:'bdstark',type:'User'}},head,base),null);
});
test('stacked cleanup retargets dependencies but preserves source branch',async()=>{
 const calls=[];
 const pr={number:1,merged:true,head:{sha:head,ref:'feature',repo:{full_name:'bdstark/gma3-mcp'}},base:{sha:base,ref:'main'}};
 const g={paginate:async()=>[{number:2}],rest:{pulls:{get:async()=>({data:pr}),list:()=>{},update:async x=>calls.push(['retarget',x.base])},issues:{createComment:async()=>calls.push(['comment'])}}};
 await main({github:g,context:{repo:{owner:'bdstark',repo:'gma3-mcp'}},core:{info(){}},mode:'cleanup'});
 assert.deepEqual(calls,[['retarget','main'],['comment']]);
});
test('cleanup never deletes a protected or advanced branch',async()=>{
 for(const branch of [{protected:true,commit:{sha:head}},{protected:false,commit:{sha:base}}]){
  let deleted=false;
  const pr={number:1,merged:true,head:{sha:head,ref:'feature',repo:{full_name:'bdstark/gma3-mcp'}},base:{sha:base,ref:'main'}};
  const g={paginate:async()=>[],rest:{pulls:{get:async()=>({data:pr}),list:()=>{}},repos:{getBranch:async()=>({data:branch})},git:{deleteRef:async()=>{deleted=true}}}};
  await main({github:g,context:{repo:{owner:'bdstark',repo:'gma3-mcp'}},core:{info(){}},mode:'cleanup'});
  assert.equal(deleted,false);
 }
});
