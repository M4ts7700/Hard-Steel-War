const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
function loadModules(names,globals={}){
  const ctx=vm.createContext({MODULES:{},URL,...globals});
  for(const name of names){
    const start=html.indexOf(`MODULES["${name}"]=`);
    assert.ok(start>=0,name);
    vm.runInContext(html.slice(start,html.indexOf('\nMODULES[',start+1)),ctx);
  }
  return ctx.MODULES;
}

const simulationModules=['data.js','tactics.js','spatial.js','ballistics.js','simulation.js'];
function assertAngle(actual,expected){
  const delta=actual-expected;
  assert.ok(Math.abs(Math.atan2(Math.sin(delta),Math.cos(delta)))<1e-8,
    `expected ${actual} to match ${expected} radians`);
}

test('broken traverse locks the turret at its current angle relative to the turning hull',()=>{
  const {Game}=loadModules(simulationModules)['simulation.js'];
  const game=new Game({seed:1,randomTerrain:false}),tank=game.player;
  tank.angle=Math.PI-.02;
  tank.turretAngle=tank.angle+.7;
  tank.modules.turret=0;
  game._playerControl(tank,.2,{steer:1,aimX:tank.x,aimZ:tank.z+100});
  assert.ok(tank.angle<0,'hull turned through the angle wrap');
  assertAngle(tank.turretAngle-tank.angle,.7);

  tank.modules.turret=100;
  const heading=tank.turretAngle;
  game._move(tank,.2,0,1);
  assertAngle(tank.turretAngle,heading);
});

test('multiplayer steering and host corrections preserve a broken turret’s hull-relative angle',()=>{
  const modules=loadModules([...simulationModules,'appearance.js','leaderboard.js','multiplayer-game.js']);
  const {ReplicaBattle}=modules['multiplayer-game.js'];
  const game=Object.create(ReplicaBattle.prototype);
  const tank={id:'player',type:'pz4f2',alive:true,team:0,x:0,y:0,z:0,angle:.5,
    turretAngle:1.2,speed:0,yawVelocity:0,gunPitch:0,modules:{engine:100,tracks:100,turret:0}};
  const snapshot={time:1,tanks:[tank],shells:[],smokeClouds:[],tickets:[10,10],stats:{player:{}}};
  Object.assign(game,{localId:'player',localTeam:0,tanks:[{...tank,angle:1}],zones:[],
    map:modules['data.js'].getMap('valley'),descriptor:{},_authority:snapshot,snapshots:[{state:snapshot,at:1000}]});
  game.advance(.1,{steer:1},1000);
  assert.ok(game.player.angle>.5,'the replica still uses its predicted hull heading');
  assertAngle(game.player.turretAngle-game.player.angle,.7);
});

test('invite copy handles browser clipboard rejection and a downloaded game page',async()=>{
  const publicAddress=/rel="canonical" href="([^"]+)"/.exec(html)[1];
  const clipboard=[],toasts=[];
  let buffer,removed=0;
  const button={focus(){document.activeElement=this;}};
  const modal={append(field){buffer=field;}};
  const document={
    activeElement:button,
    querySelector(selector){return selector==='#modal-content'?modal:{href:publicAddress};},
    createElement(){return {style:{},focus(){document.activeElement=this;},select(){this.selected=true;},
      remove(){removed++;buffer=null;}};},
    execCommand(command){
      assert.equal(command,'copy');
      assert.equal(document.activeElement,buffer);
      assert.ok(buffer.selected);
      clipboard.push(buffer.value);
      return true;
    }
  };
  const navigator={clipboard:{async writeText(){throw new Error('Clipboard access denied');}}};
  const modules=loadModules(['realtime.js','room-links.js','multiplayer-ui.js'],{
    document,navigator,location:{href:'file:///game/index.html'},
    MODULES:Object.fromEntries(['public-server-ui.js','multiplayer.js','online-config.js','data.js','leaderboard.js','i18n.js']
      .map(name=>[name,{}]))
  });
  const ui=Object.create(modules['multiplayer-ui.js'].MultiplayerUI.prototype);
  ui.room={code:'ABCDEFGH'};
  ui.toast=message=>toasts.push(message);
  await ui.copyInvite(true);
  delete navigator.clipboard;
  await ui.copyInvite(false);
  assert.deepEqual(clipboard,[new URL('?room=ABCDEFGH',publicAddress).href,'ABCDEFGH']);
  assert.deepEqual(toasts,['Odkaz na místnost zkopírován.','Kód místnosti zkopírován.']);
  assert.equal(removed,2);
  assert.equal(document.activeElement,button);
});
