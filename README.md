Warning: Complete slop. I haven't read a single line of this repo. -Jacob

# Petalwake

*A broom, an island, a good wind.*

Petalwake is a small browser game about flying low and fast over flower meadows, sea cliffs and
open water, and about what the air does behind you. The broom sheds a simulated pair of wake
vortices, and the world answers to them: petals are wound up and carried along, grass is laid
over, spray is torn off the sea, and the flowers you pass are left with fewer petals, the faster
you went by.

The island has people on it. Larkhaven is a harbour town of about a hundred hand-modelled
buildings on the south shore; Cairnwick is a village on the northern cliffs; farms, mills and a
beacon stand out in the meadows. A quarter of the buildings have somewhere high to set down: a
tower gallery, a roof terrace, a lighthouse walk. Land there to deliver the parcel you are
carrying and pick up the next.

**Play it: <https://petalwake.non.io/v2>** (a desktop browser with WebGL2; the first load is about 95 MB).
The first version, from before the towns, is still at <https://petalwake.non.io>.

![Sprinting over the meadow with petals wound into the wake](screenshots/meadow_wake.jpg)

<p>
  <img src="screenshots/island.jpg" width="49%" alt="The island from out at sea">
  <img src="screenshots/sea_spray.jpg" width="49%" alt="Spray torn off the water behind the broom">
  <img src="screenshots/fjord_waterfall.jpg" width="49%" alt="The fjord and its waterfall">
  <img src="screenshots/meadow_track.jpg" width="49%" alt="Three passes at three speeds: the faster the pass, the more petals are gone">
  <img src="screenshots/lighthouse.jpg" width="49%" alt="The lighthouse on its sea stack">
  <img src="screenshots/stone_circle.jpg" width="49%" alt="Standing stones in the meadow">
</p>

![Larkhaven from the sea](screenshots/larkhaven_harbour.jpg)

<p>
  <img src="screenshots/larkhaven_square.jpg" width="49%" alt="The market square in Larkhaven">
  <img src="screenshots/larkhaven_above.jpg" width="49%" alt="The square, the walled orchard and the Crown on its hill">
  <img src="screenshots/landing_approach.jpg" width="49%" alt="Coming in to land on the Star-gazer's Tower, its gallery lit up">
  <img src="screenshots/landing_landed.jpg" width="49%" alt="Landed on the Couriers' Guild, over the market square">
  <img src="screenshots/delivery_beacon.jpg" width="49%" alt="A gold light over the tower the parcel is for">
  <img src="screenshots/kickflip.jpg" width="49%" alt="A kickflip along the quay">
  <img src="screenshots/cairnwick.jpg" width="49%" alt="Cairnwick, the village on the northern cliffs">
  <img src="screenshots/farmstead.jpg" width="49%" alt="A farm and its orchard out in the meadows">
  <img src="screenshots/place_kettle_pools.jpg" width="49%" alt="The Kettle Pools, one of twelve hidden places">
  <img src="screenshots/shore_crabs.jpg" width="49%" alt="Crabs on the south beach">
</p>

## Controls

| | |
|---|---|
| <kbd>W</kbd> <kbd>S</kbd> or <kbd>↑</kbd> <kbd>↓</kbd> | dive, climb |
| <kbd>A</kbd> <kbd>D</kbd> or <kbd>←</kbd> <kbd>→</kbd> | bank |
| <kbd>Shift</kbd> | ride the gust (boost) |
| <kbd>Space</kbd> | ease up (brake); on the catbus, take off from the ground |
| <kbd>Space</kbd> <kbd>Space</kbd> | land on a tower, a roof, or open ground; <kbd>Space</kbd> again to take off |
| <kbd>E</kbd> | mount or dismount the catbus (or call it when landed) |
| <kbd>Q</kbd> | kickflip, once you have caught ten wind seeds |
| <kbd>J</kbd> | the journal of treasures found |
| Mouse | click the view to steer with it; left button boosts, right button brakes |
| <kbd>C</kbd> | camera: chase, low, far |
| <kbd>I</kbd> | invert pitch |
| <kbd>P</kbd> | hide the HUD |
| <kbd>M</kbd> | mute |
| Gamepad | left stick steers, right trigger or A boosts, left trigger or B brakes |

There is no way to fail. A dive rounds itself out and lands with a bounce, walls push you off, and
the wind turns you home if you wander too far out to sea. Glowing wind seeds are scattered along
the island's best lines; catching one tops up the gust.

There is always one parcel to deliver. A gold light stands over the tower it is for, and the
compass points the way: sometimes a hop across town, sometimes a flight to the other end of the
island. Twelve odd places are hidden around the coast and the hills, each with its own plants and
a treasure to find; the journal keeps hints for the ones you have not found. Down on the shore,
the rocks are crusted with barnacles and the crabs run for it when you come by.

## Run it locally

There is no build step: the page loads ES modules straight from `src/`.

```bash
python3 tools/serve.py
```

Then open <http://localhost:6280>. Any static file server works just as well (it has to be served
over HTTP; opening `index.html` from disk will not load the modules).

Options in the URL: `?q=low|medium|high` sets the meadow density, `?dpr=1.5` sets the pixel ratio,
`?noscale` turns off the automatic resolution scaling, `?play` skips the title screen.

It has been developed and checked in Chrome only.

## How it works

Everything is vanilla JavaScript on [three.js](https://threejs.org) r187 (WebGL2), with custom
shaders for nearly all of it.

- **The wake** ([src/fx/vortex.js](src/fx/vortex.js)). A ring of 256 cross-sections is laid down
  behind the broom, each holding a counter-rotating pair of vortex cores. The cores drive each
  other and their mirror images under the ground, so the pair sinks and then runs apart along the
  deck; they fatten and weaken with age, drift on the wind, and are shed unsteadily so no two
  stretches are alike. The ring starts tight at the broom and opens up behind it.
- **What the wake does.** Particles (petals, leaves, spray, grit) sample the vortices on the CPU
  ([src/fx/particles.js](src/fx/particles.js), [src/fx/windfx.js](src/fx/windfx.js)). The same
  trail is drawn as a ribbon into two top-down maps: a scrolling field that grass, flowers, trees
  and water read to lean, thrash and foam ([src/fx/wake.js](src/fx/wake.js)), and an island-wide
  map of how many petals each spot has lost ([src/fx/strip.js](src/fx/strip.js)).
- **The meadow** ([src/world/meadow.js](src/world/meadow.js)). Grass and flowers are placed on the
  GPU around the camera. Flowers form one continuous field that thins by rank with distance, and
  drop their petals one at a time as the map above fills in.
- **The island** ([src/world/terrain.js](src/world/terrain.js),
  [tools/terrain/bake.py](tools/terrain/bake.py)). A 6 km square heightfield, 4096 samples a side,
  baked offline: stratified sea cliffs, a fjord, droplet erosion, a river and its waterfall, flower
  drifts, and the light and shadow maps. It is drawn as a CDLOD quadtree with stochastic texture
  sampling to hide tiling.
- **Sea, river, sky** ([src/world/water.js](src/world/water.js),
  [src/world/river.js](src/world/river.js), [src/world/clouds.js](src/world/clouds.js)). Gerstner
  swell with shore surf and reflections; ray-marched clouds baked into a sky texture at load.
- **The towns** ([src/world/town.js](src/world/town.js), [tools/town](tools/town)). Every building
  is a short Python script that models it in Blender with a small kit of parts (walls with real
  openings, stepped-course roofs, galleries, chimneys, signs): see
  [tools/town/README.md](tools/town/README.md). A layout script seats them along hand-drawn
  streets, the terrain is cut and filled to suit (the quay, the harbour basin, the moles), and the
  lot is packed into quantised chunks with three levels of detail, a baked sun shadow map per
  town, and a height grid for collisions.
- **Errands** ([src/game](src/game)). Landing places, the approach and the dismount, deliveries,
  and the kickflip.
- **Hidden places and shore life** ([src/world/places.js](src/world/places.js),
  [src/world/shore.js](src/world/shore.js)). Twelve dressed sites with a treasure each; barnacles,
  weed and crabs along the coast.
- **Flight and camera** ([src/player/flight.js](src/player/flight.js),
  [src/player/camera.js](src/player/camera.js)). An arcade model tuned for skimming; the chase
  camera closes in when you slow down and pulls back when you sprint.
- **Frame** ([src/core/pipeline.js](src/core/pipeline.js)). HDR with MSAA, camera motion blur with
  the rider and particles drawn sharp on top, bloom, god rays, a light lens pass and tonemapping.
- **Sound** ([src/audio/audio.js](src/audio/audio.js)). Synthesised in the browser; no audio files.

## Layout

```
index.html          the page, the title screen and the HUD
src/                the game
  core/             shared uniforms, the frame pipeline
  world/            terrain, meadow, water, river, sky, clouds, props, seeds, towns, places, shore
  player/           flight model, camera, input, the rider
  game/             landing, deliveries, the kickflip
  ui/               the journal
  fx/               wake vortices, wake maps, particles, wind effects
  shaders/          GLSL shared by every material
  audio/            procedural sound
assets/             what the game loads: baked terrain, models, textures
vendor/three/       three.js r187, copied unmodified from the npm package
tools/
  serve.py          dev server (no caching, optional frame capture)
  terrain/bake.py   builds everything in assets/terrain
  town/             the building kit, one script per building, layout, terrain fitting, packing
  shore/            builds the little kit of shells, weed, boulders and crabs
  places/           lays out the hidden places
  gen/              concept art, models and materials from fal and Meshy
  blender/          turns generated meshes into game assets
screenshots/
```

## Rebuilding the island

The world is defined in `tools/terrain/bake.py`; change it there, not in the game.

```bash
python3 -m venv tools/.venv
tools/.venv/bin/pip install -r tools/requirements.txt
tools/.venv/bin/python tools/terrain/bake.py 4096 --keep-props
```

A bake takes a little over a minute. `--keep-props` keeps trees, stones and boulders where they
are; leave it off to scatter them afresh.

## Rebuilding the towns

Buildings and street furniture are modelled by the scripts in `tools/town/buildings` and
`tools/town/props`, run inside Blender (5.2):

```bash
/Applications/Blender.app/Contents/MacOS/Blender -b -P tools/town/make.py -- h_inn --render --blend
```

That writes the mesh the game uses to `art/town/build`, a preview picture and a `.blend` file to
open. `tools/town/layout.py` says where everything stands. After changing either:

```bash
tools/town/build.sh
```

plans the lots, fits the ground and packs `assets/town`. `MODELS=1 tools/town/build.sh` runs every
building script through Blender first (a few minutes), which a fresh clone needs once since
`art/` is not in the repository. Fitting the ground always starts from the untouched island bake,
kept in `art/terrain_base`; on a fresh clone, bake the island first (above) so that the copy it
takes is a clean one.

## Regenerating the art

The rider, the trees and stones, and the pieces of the hidden places were generated, not modelled by hand: concept images from fal
(`nano-banana-pro`), meshes from Meshy (`meshy-7.1`, image to 3D), ground and rock materials from
fal (`patina`), then cleaned up, weighted for wind and exported with the Blender scripts. The
scripts in `tools/gen` read `FAL_KEY` and `MESHY_API_KEY` from the environment. Their raw output
goes to `art/`, which is not in this repository (it is about 250 MB); the processed results in
`assets/` are.

## License and credits

Petalwake is released under the MIT License: see [LICENSE](LICENSE).

- [three.js](https://threejs.org) r187, MIT. See [vendor/three/LICENSE](vendor/three/LICENSE).
  It bundles the meshoptimizer decoder (MIT, Arseny Kapoulkine).
- Fraunces and Karla, loaded from Google Fonts, SIL Open Font License.
- Models and materials generated with [Meshy](https://www.meshy.ai) and [fal](https://fal.ai).

## How it was made

Petalwake was built in a day with [Claude Code](https://claude.com/claude-code) (Claude Fable 5.2)
from a short brief and a reference clip for the mood, then tuned over a few rounds of play-testing
notes. The towns, the deliveries, the hidden places and the shore life were added the next day,
with the buildings modelled by a handful of helper agents working two at a time. The code, the
shaders, the terrain bake and the asset pipeline were written by the model; the art was generated
with the services credited above, apart from the buildings, which are modelled in code.
