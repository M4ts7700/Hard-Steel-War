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
      'localTexture=()=>null; return {makeTankBase};');
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
