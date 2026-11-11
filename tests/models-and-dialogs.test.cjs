const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.join(__dirname,'..');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8').replace(/\r\n/g,'\n');

test('tank models build with finite geometry and distinct variant shapes',()=>{
  const ctx=vm.createContext({MODULES:{},console});
  vm.runInContext(fs.readFileSync(path.join(root,'vendor/three.js'),'utf8'),ctx);
  for(const name of ['data.js','appearance.js','ballistics.js','renderer.js']){
    const start=html.indexOf(`MODULES["${name}"]=`,0);
    let source=html.slice(start,html.indexOf('\nMODULES[',start+1));
    if(name==='renderer.js')source=source.replace('return {terrainGeometry,muzzleEffectProfile,Renderer};',
      'localTexture=()=>null; return {makeTankBase,Renderer};');
    vm.runInContext(source,ctx);
  }
  const models=vm.runInContext(`MODULES['data.js'].TANKS.map(t=>[t.id,MODULES['renderer.js'].makeTankBase(t.id)])`,ctx);
  const signatures=new Map();
  for(const [id,model] of models){
    const shapes=[];
    model.group.updateMatrixWorld(true);
    model.group.traverse(mesh=>{
      if(!mesh.isMesh)return;
      const positions=Array.from(mesh.geometry.attributes.position.array);
      assert.ok(positions.every(Number.isFinite),id+' has finite vertices');
      shapes.push([positions,Array.from(mesh.matrixWorld.elements)]);
    });
    signatures.set(id,JSON.stringify(shapes));
  }
  for(const [a,b] of [['pz4f2','pz4h'],['tigerh1','tigere'],['m4a1','m4a2'],['m4a2','m4a376'],['t341941','t341942'],['t341942','t3485'],['is1','is2']]){
    assert.notEqual(signatures.get(a),signatures.get(b),a+' differs from '+b);
  }
  const lineup=vm.runInContext(`(()=>{
    const r=Object.create(MODULES['renderer.js'].Renderer.prototype);
    r.camera=new THREE.PerspectiveCamera(34,1600/340,.1,180);
    r.scene=new THREE.Scene();r.scene.fog=new THREE.FogExp2('#111b1e',.01);
    r.world=new THREE.Group();r.dynamic=new THREE.Group();r.resize=()=>{};
    r.setHangar=()=>{r.world.clear();r.dynamic.clear();};
    const members=MODULES['data.js'].TANKS.slice(0,8).map((t,i)=>({id:String(i),tankId:t.id,team:i%2}));
    r.setLobby(members,8);
    const tanks=r.dynamic.children.filter(c=>c.isGroup),first=tanks[0];
    r.setLobby(members.map(m=>({...m,ready:true})),8);
    const reused=r.dynamic.children.includes(first);
    const positions=tanks.map(t=>t.position.x);
    r.setLobby(members.slice(0,2),4);
    return {positions,reused,count:r.dynamic.children.filter(c=>c.isGroup).length,
      cameraWidth:r.lobbyCamera.right-r.lobbyCamera.left,mode:r.mode};
  })()`,ctx);
  assert.equal(new Set(lineup.positions).size,8,'each player has a separate position');
  assert.ok(lineup.reused,'ready changes do not rebuild the models');
  assert.equal(lineup.count,2,'departed players are removed');
  assert.equal(lineup.cameraWidth,36);
  assert.equal(lineup.mode,'lobby');
});

test('Escape closes account and scores even while a form field has focus',()=>{
  const start=html.indexOf("document.addEventListener('keydown',e=>{\n  if(e.target.id==='server-chat-input')");
  assert.ok(start>=0);
  const end=html.indexOf("  if(!game||paused)return;",start);
  for(const view of ['account','scores']){
    let handler,closed=0,prevented=0;
    const ctx=vm.createContext({
      document:{addEventListener:(_,fn)=>handler=fn},customDraft:null,game:null,
      modalView:view,performance:{now:()=>1000},lastUnlock:0,
      closeModal:()=>closed++,pause:()=>assert.fail('unexpected pause')
    });
    vm.runInContext(html.slice(start,end)+'});',ctx);
    handler({code:'Escape',target:{id:'username',matches:()=>true},preventDefault:()=>prevented++});
    assert.equal(closed,1);assert.equal(prevented,1);
  }
});

test('account and scores click handlers do not reopen a dialog after its close button',()=>{
  // Model the actual ancestor relationship: the backdrop also has data-view.
  function element(tag,dataset={},parent=null){
    return {tag,dataset,parent,closest(selector){
      const match=/^(button)?\[data-([a-z-]+)(?:="([^"]+)")?\]$/.exec(selector);
      assert.ok(match,'supported selector: '+selector);
      const key=match[2].replace(/-([a-z])/g,(_,c)=>c.toUpperCase());
      for(let node=this;node;node=node.parent){
        if((!match[1]||node.tag===match[1])&&key in node.dataset&&
          (match[3]===undefined||node.dataset[key]===match[3]))return node;
      }
      return null;
    }};
  }
  for(const view of ['account','scores']){
    let handler,opened=0;
    const marker=view==='account'?'class AccountUI{':'async function showScores(';
    const start=html.indexOf("document.addEventListener('click',e=>{",html.indexOf(marker));
    const end=html.indexOf('\n  });',start);
    const source=view==='account'?html.slice(start,end+6):html.slice(start,html.indexOf('\n});',start)+4);
    const ctx=vm.createContext({document:{addEventListener:(_,fn)=>handler=fn},
      open:()=>opened++,showScores:()=>opened++});
    vm.runInContext(source,ctx);
    const backdrop=element('div',{view}),dialog=element('section',{},backdrop);
    const closeButton=element('button',{},dialog);
    handler({target:closeButton});
    handler({target:element('span',{},closeButton)});
    handler({target:element('p',{},dialog)});
    assert.equal(opened,0,view+' stays closed and content clicks do not reopen it');
    handler({target:element('span',{},element('button',{view},dialog))});
    assert.equal(opened,1,view+' still opens from its navigation button');
  }
});
