const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8').replace(/\r\n/g,'\n');

function setup(hash=''){
 const nodes=new Map();let table;
 function node(id){
  if(!nodes.has(id))nodes.set(id,{hidden:id==='#scores-page',focus(){},isConnected:true,
   set innerHTML(value){this.value=value;if(id==='#scores-content'){
    if(table)table.isConnected=false;
    table={isConnected:true,innerHTML:'',textContent:''};
   }},get innerHTML(){return this.value||'';}});
  return nodes.get(id);
 }
 const location={hash,pathname:'/game/',search:'?lang=en'},history=[];
 const pending=[];
 const ctx=vm.createContext({location,history:{pushState:(_,__,url)=>{
  history.push(url);location.hash=url.includes('#')?'#'+url.split('#')[1]:'';
 }},$:id=>id==='#online-table'?table:node(id),$$:()=>[],
 game:null,customDraft:null,modalView:'',renderer:{resize(){}},
 closeModal(){ctx.modalView='';},closeCustomization(){ctx.customDraft=null;},
 account:{list:()=>new Promise(resolve=>pending.push(resolve))},
 esc:s=>s,num:n=>n});
 const start=html.indexOf('function leaveScoresPage(');
 vm.runInContext(html.slice(start,html.indexOf('\nfunction showScoreEntry',start)),ctx);
 return {ctx,node,location,history,pending,table:()=>table};
}

test('TOP 5 has a direct route and returns to hangar through browser navigation',async()=>{
 const s=setup('#top5');s.ctx.syncPageRoute();
 assert.equal(s.node('#scores-page').hidden,false);
 assert.equal(s.node('#hangar').hidden,false);
 assert.equal(s.ctx.modalView,'');
 assert.equal(s.history.length,0,'opening a direct link does not add another history entry');
 s.location.hash='';s.ctx.syncPageRoute();
 assert.equal(s.node('#scores-page').hidden,true);
 assert.equal(s.node('#hangar').hidden,false);
 s.location.hash='#top5';s.ctx.syncPageRoute();
 assert.equal(s.node('#scores-page').hidden,false,'Forward reopens the page');
 s.ctx.leaveScoresPage();
 assert.equal(s.history.at(-1),'/game/?lang=en');
 assert.equal(s.node('#scores-page').hidden,true);
});

test('period changes keep one route and stale responses cannot replace the current table',async()=>{
 const s=setup();const first=s.ctx.showScores();const oldTable=s.table();
 const second=s.ctx.showScores('all');
 assert.deepEqual(s.history,[]);
 s.pending[1]([{nick:'Current',score:20}]);await second;
 s.pending[0]([{nick:'Old',score:10}]);await first;
 assert.match(s.table().innerHTML,/Current/);
 assert.doesNotMatch(s.table().innerHTML,/Old/);
 assert.equal(oldTable.isConnected,false);
});

test('opening TOP 5 closes an overlay but does not interrupt a battle',async()=>{
 const s=setup();s.ctx.modalView='account';s.ctx.showScores();
 assert.equal(s.ctx.modalView,'');
 s.ctx.leaveScoresPage();s.ctx.game={};await s.ctx.showScores();
 assert.equal(s.node('#scores-page').hidden,true);
 assert.equal(s.location.hash,'');
});
