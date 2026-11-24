const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const context = vm.createContext({ MODULES: {} });
for (const name of ['data.js', 'tactics.js', 'spatial.js', 'ballistics.js', 'simulation.js']) {
  const start = html.indexOf(`MODULES["${name}"]=`);
  vm.runInContext(html.slice(start, html.indexOf('\nMODULES[', start + 1)), context);
}
const { Game } = context.MODULES['simulation.js'];

test('demolition reopens the same navigation cells as a full rebuild', () => {
  const game = new Game({ mapId: 'city', seed: 1 });
  const grid = game._nav;
  const initialOpen = grid.cells.filter(cell => cell.open).length;
  const buildings = game.initialProps.flatMap((prop, i) => prop.type === 'building' ? [i] : []);
  const compareGrid = () => assert.deepEqual(
    grid.cells.map(cell => cell.open),
    game._buildNav().cells.map(cell => cell.open)
  );

  assert.ok(game.demolish(buildings[0]));
  assert.equal(game.demolish(buildings[0]), false);
  compareGrid();
  game._wipeProps(buildings.slice(0, 20));
  assert.equal(game._nav, grid);
  assert.ok(grid.cells.filter(cell => cell.open).length > initialOpen);
  compareGrid();
});

test('a world without bot navigation still applies bridge and prop destruction', () => {
  const game = new Game({ mapId: 'valley', seed: 1, randomTerrain: false, navigate: false });
  const building = game.initialProps.findIndex(prop => prop.type === 'building');
  assert.ok(game.demolish(building));
  assert.ok(!game.map.obstacles.includes(game.initialProps[building]));
  assert.ok(game.breakBridge(0));
  assert.ok(!game.map.bridges.includes(game.initialBridges[0]));
  assert.equal(game._nav, null);
});

test('releasing a finished battle map drops its seeded world and damaged copies only', () => {
  const { createBattleMap, removeBridgeDeck, releaseBattleMap, getMap } = context.MODULES['data.js'];
  const kept = createBattleMap('valley', 12);
  const map = { ...createBattleMap('valley', 11) };
  const world = map.id;
  removeBridgeDeck(map, map.bridges[0]);
  assert.notEqual(map.id, world);
  assert.equal(getMap(map.id), map);
  releaseBattleMap(map.id);
  assert.equal(getMap(world).id, 'valley');
  assert.equal(getMap(map.id).id, 'valley');
  assert.equal(getMap(kept.id), kept);
});
