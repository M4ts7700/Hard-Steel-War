const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const html=fs.readFileSync(require('node:path').join(__dirname,'../index.html'),'utf8');
function setup(){
  const targets=new Map();
  function target(id){
    if(!targets.has(id))targets.set(id,{
      handlers:{},style:{},
      addEventListener(name,fn){this.handlers[name]=fn;},
      setPointerCapture(){},
      getBoundingClientRect(){return {left:0,top:0,width:116,height:116};},
      querySelector(){return target('knob');},
      emit(name,id,x=58,y=58){this.handlers[name]({pointerId:id,clientX:x,clientY:y,preventDefault(){},currentTarget:this});}
    });
    return targets.get(id);
  }
  const ctx=vm.createContext({$:target});
  vm.runInContext('let game={finished:false},paused=false,touchAim=false,stickPointer=null,touchDrive={throttle:0,steer:0},touchMG=false,mgRequested=false;const cruise={reset(){}};',ctx);
  const start=html.indexOf("const touchStick=$('#touch-stick');");
  vm.runInContext(html.slice(start,html.indexOf('let wasLiveFrame=false;',start)),ctx);
  return {target,read:expr=>vm.runInContext(expr,ctx)};
}
test('joystick allows diagonal drive, clamps travel and stops only for its own finger',()=>{
  const {target,read}=setup(),stick=target('#touch-stick');
  stick.emit('pointerdown',1,500,-500);
  assert.ok(read('touchDrive.throttle>0 && touchDrive.steer<0'));
  assert.ok(read('Math.abs(touchDrive.throttle)<=1 && Math.abs(touchDrive.steer)<=1'));
  stick.emit('pointerdown',2,58,116);
  stick.emit('pointerup',2);
  assert.equal(read('stickPointer'),1);
  stick.emit('pointercancel',1);
  assert.equal(read('touchDrive.throttle'),0);
  assert.equal(read('touchDrive.steer'),0);
  assert.equal(target('knob').style.transform,'');
});
test('machine gun and driving can be held independently; capture loss releases fire',()=>{
  const {target,read}=setup();
  target('#touch-stick').emit('pointerdown',1,58,0);
  target('#touch-mg').emit('pointerdown',2);
  assert.equal(read('touchMG && touchDrive.throttle>0'),true);
  target('#touch-mg').emit('lostpointercapture',2);
  assert.equal(read('touchMG'),false);
  assert.equal(read('stickPointer'),1);
});
test('paused game ignores mobile drive and fire',()=>{
  const {target,read}=setup();read('paused=true');
  target('#touch-stick').emit('pointerdown',1,58,0);
  target('#touch-mg').emit('pointerdown',2);
  assert.equal(read('stickPointer'),null);
  assert.equal(read('touchMG'),false);
});
