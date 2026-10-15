# Swiss Map Component

Used for geography, history, cities, humanities routes, store/campus/event locations and similar content. It is not a new Swiss body layout but an **extension of S08 Duo Compare's right slot**: the left side remains explanation cards, and the right side is replaced by the map component.

## When to use

- The document contains places, blocks, routes, residences, institution distributions, city wandering.
- The user explicitly wants a map, pins, relation lines or a geographic component.
- The content needs to explain "spatial relations", not just list people or places.

## Hard rules

- The `<section>` still writes `data-layout="S08"`; do not add `P23/P24` or custom body pages.
- The page structure must be: top heading + left explanation cards + right map card.
- Map markers are composed of HTML components: pin `.pin-dot` + line `.pin-line` + card `.pin-card`.
- SVG only draws fallback relation lines; do not write text in SVG.
- The MapLibre map disables wheel zoom and dragging by default, avoiding deck page-flip triggers.
- `+` / `-` / `DRAG` controls are required at the top-right. Dragging is allowed only after the user clicks `DRAG`.
- A static fallback is mandatory: when the CDN or map tiles fail, pins, relation lines and cards remain visible.

## Data contract

Define points and relations before writing the page. `x/y` are percentage coordinates for the static fallback; `coord` is the MapLibre longitude/latitude.

```js
const MAP_POINTS = [
  { id: 'gu', name: '顾维钧', meta: '外交', coord: [117.2048, 39.1060], x: 62, y: 68, accent: true },
  { id: 'cao', name: '曹锟', meta: '北洋', coord: [117.1988, 39.1080], x: 34, y: 48 },
  { id: 'sun', name: '孙殿英', meta: '军阀', coord: [117.2028, 39.1090], x: 52, y: 54 },
  { id: 'zhang', name: '张自忠', meta: '抗战', coord: [117.1966, 39.1120], x: 58, y: 28, accent: true },
  { id: 'jin', name: '金氏宅邸', meta: '交通站', coord: [117.2012, 39.1114], x: 66, y: 35, side: 'left' },
];

const MAP_RELATIONS = [
  ['gu', 'cao'],
  ['cao', 'sun'],
  ['zhang', 'jin'],
];
```

## Required CSS

Put this into an extra `<style>` in the generated page's `<head>`; do not modify `template-swiss.html`'s global base classes.

```html
<link href="https://unpkg.com/maplibre-gl@5.14.0/dist/maplibre-gl.css" rel="stylesheet">
<script src="https://unpkg.com/maplibre-gl@5.14.0/dist/maplibre-gl.js"></script>
<style>
.history-map-grid{display:grid;grid-template-columns:4.2fr 7.8fr;gap:2vw;flex:1;min-height:0;margin-top:2vh;align-items:stretch}
.history-side{display:grid;grid-template-rows:1.08fr repeat(4,1fr);gap:1vh;min-height:0;height:100%}
.history-side-head{background:var(--accent);color:var(--accent-on);padding:2.2vh 1.4vw 1.8vh;border-radius:3px}
.history-side-head .big{font-family:var(--sans),var(--sans-zh);font-size:max(22px,2.2vw);font-weight:300;line-height:1.08;letter-spacing:-.02em}
.history-side-head .small{font-family:var(--sans),var(--sans-zh);font-size:max(11px,.82vw);font-weight:300;line-height:1.55;color:rgba(255,255,255,.82);margin-top:1.2vh}
.relation-card{background:var(--grey-1);padding:1.45vh 1.1vw;border-radius:3px;display:grid;grid-template-columns:auto 1fr;gap:.8vw;align-items:start;min-height:0}
.relation-card .nb{font-family:var(--mono);font-size:max(10px,.75vw);letter-spacing:.16em;color:var(--accent)}
.relation-card .ttl{font-family:var(--sans),var(--sans-zh);font-size:max(14px,1.05vw);font-weight:500;line-height:1.25}
.relation-card .desc{font-family:var(--sans),var(--sans-zh);font-size:max(11px,.78vw);line-height:1.5;color:var(--text-secondary);margin-top:.55vh}
.map-panel{position:relative;background:var(--grey-1);border-radius:3px;overflow:hidden;min-height:0;height:100%}
.map-panel .map-title{position:absolute;top:1.4vh;left:1.2vw;z-index:3;background:rgba(250,250,248,.92);padding:1.2vh 1vw;border-radius:3px;max-width:28vw}
.map-panel .map-title .k{font-family:var(--mono);font-size:max(10px,.72vw);letter-spacing:.18em;color:var(--text-helper)}
.map-panel .map-title .t{font-family:var(--sans),var(--sans-zh);font-size:max(18px,1.5vw);font-weight:400;letter-spacing:-.015em;margin-top:.4vh}
.map-controls{position:absolute;top:1.4vh;right:1.2vw;z-index:4;display:flex;gap:6px;background:rgba(250,250,248,.9);padding:6px;border-radius:3px}
.map-ctrl{min-width:32px;height:32px;border:1px solid var(--ink);background:transparent;color:var(--ink);font-family:var(--mono);font-size:12px;letter-spacing:.08em;text-transform:uppercase;border-radius:0;cursor:pointer}
.map-ctrl.drag{min-width:58px}
.map-ctrl.active{background:var(--accent);border-color:var(--accent);color:var(--accent-on)}
.wudadao-map,.swiss-map{position:absolute;inset:0;background:#f4f4f0}
.wudadao-map.map-live .map-static,.swiss-map.map-live .map-static{display:none}
.map-static{position:absolute;inset:0;display:block;background:linear-gradient(18deg,transparent 0 44%,rgba(25,25,25,.11) 44% 44.2%,transparent 44.2%),linear-gradient(-8deg,transparent 0 54%,rgba(25,25,25,.09) 54% 54.16%,transparent 54.16%),linear-gradient(0deg,transparent 0 61%,rgba(25,25,25,.08) 61% 61.15%,transparent 61.15%),#f4f4f0}
.static-relations{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
.static-relations line{stroke:var(--accent);stroke-width:.24;stroke-dasharray:1.4 1.2;opacity:.68}
.static-marker{position:absolute;transform:translate(-50%,-50%);width:0;height:0}
.static-marker .pin-dot,.person-marker .pin-dot{position:absolute;left:-6px;top:-6px;width:12px;height:12px;border-radius:50%;background:var(--ink);border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.22)}
.static-marker.accent .pin-dot,.person-marker.accent .pin-dot{background:var(--accent)}
.static-marker .pin-line,.person-marker .pin-line{position:absolute;left:7px;top:0;width:24px;height:1px;background:var(--ink);opacity:.45}
.static-marker.accent .pin-line,.person-marker.accent .pin-line{background:var(--accent);opacity:.75}
.static-marker .pin-card,.person-marker .pin-card{position:absolute;left:31px;top:-18px;min-width:72px;background:rgba(250,250,248,.9);box-shadow:0 0 0 1px rgba(0,0,0,.06);border-radius:2px;padding:6px 7px;font-family:var(--sans),var(--sans-zh);white-space:nowrap}
.static-marker .pin-name,.person-marker .pin-name{font-size:12px;line-height:1.05;color:var(--ink)}
.static-marker .pin-meta,.person-marker .pin-meta{font-family:var(--mono);font-size:9px;line-height:1;letter-spacing:.12em;color:var(--text-helper);margin-top:4px;text-transform:uppercase}
.static-marker.accent .pin-name,.person-marker.accent .pin-name{color:var(--accent)}
.static-marker.left .pin-line,.person-marker.left .pin-line{left:auto;right:7px}
.static-marker.left .pin-card,.person-marker.left .pin-card{left:auto;right:31px}
.person-marker{position:relative;width:0;height:0;pointer-events:auto}
.maplibregl-ctrl-bottom-left,.maplibregl-ctrl-bottom-right{display:none!important}
</style>
```

## Page skeleton

```html
<section class="slide" data-layout="S08" data-animate="duo-mirror">
  <div class="canvas-card">
    <header class="chrome-min"><div class="l">06 / NN · MAP COMPONENT</div><div class="r">MAPLIBRE / STATIC FALLBACK</div></header>
    <h2 class="h-xl-zh">把人物住所放回街区里</h2>
    <div class="history-map-grid">
      <aside class="history-side">
        <div class="history-side-head">
          <div class="big">住所不是点位，<br/>而是关系入口。</div>
          <div class="small">这页用地图承载空间关系，用左侧卡片解释人物之间的牵连。</div>
        </div>
        <div class="relation-card"><div class="nb">01</div><div><div class="ttl">顾维钧 ↔ 曹锟</div><div class="desc">说明两者为什么有关系，至少写成完整一句。</div></div></div>
        <div class="relation-card"><div class="nb">02</div><div><div class="ttl">曹锟 ↔ 孙殿英</div><div class="desc">不要只写标签，写清历史关系或空间关系。</div></div></div>
        <div class="relation-card"><div class="nb">03</div><div><div class="ttl">张自忠 ↔ 金氏宅邸</div><div class="desc">每张卡控制在 2-3 行，形成信息密度。</div></div></div>
        <div class="relation-card"><div class="nb">04</div><div><div class="ttl">张自忠 ↔ 利德尔</div><div class="desc">可以用跨身份对照补充人文厚度。</div></div></div>
      </aside>
      <div class="map-panel">
        <div class="map-title"><div class="k">RELATION MAP</div><div class="t">地点 / 人物 / 事件</div></div>
        <div class="map-controls" aria-label="地图控制">
          <button class="map-ctrl" type="button" data-map-ctrl="zoom-in" aria-label="放大地图">+</button>
          <button class="map-ctrl" type="button" data-map-ctrl="zoom-out" aria-label="缩小地图">-</button>
          <button class="map-ctrl drag" type="button" data-map-ctrl="drag" aria-label="拖动地图" aria-pressed="false">DRAG</button>
        </div>
        <div id="swiss-map" class="swiss-map" data-points='[填入 JSON]' data-relations='[填入 JSON]'>
          <div class="map-static" aria-hidden="true">
            <svg class="static-relations" viewBox="0 0 100 100" preserveAspectRatio="none">[静态连线]</svg>
            [静态 marker 卡片]
          </div>
        </div>
      </div>
    </div>
  </div>
</section>
```

## Required JS

Place before `</body>`. When generating multiple map pages, change the id from `swiss-map` to a unique id and make the init function accept a selector.

```html
<script>
(() => {
  function readJson(el, key, fallback){
    try { return JSON.parse(el.dataset[key] || ''); }
    catch { return fallback; }
  }
  function initSwissMap(){
    const el = document.getElementById('swiss-map');
    if(!el || el.dataset.ready) return;
    el.dataset.ready = '1';
    const points = readJson(el, 'points', []);
    const relations = readJson(el, 'relations', []);
    function coord(id){ return points.find(p => p.id === id).coord; }
    const panel = el.closest('.map-panel');
    panel?.addEventListener('wheel', (event) => event.stopPropagation(), {passive:true});
    ['pointerdown','pointermove','pointerup','click','dblclick','touchstart','touchmove'].forEach((type) => {
      panel?.addEventListener(type, (event) => event.stopPropagation(), {passive:true});
    });
    if(window.__lowPowerMode || !window.maplibregl){
      el.classList.add('fallback-only');
      return;
    }
    const center = points.length
      ? [points.reduce((sum, p) => sum + p.coord[0], 0) / points.length, points.reduce((sum, p) => sum + p.coord[1], 0) / points.length]
      : [0, 0];
    const map = new maplibregl.Map({
      container: el,
      style: {
        version:8,
        sources:{ osm:{ type:'raster', tiles:['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize:256, attribution:'© OpenStreetMap contributors' } },
        layers:[{ id:'osm', type:'raster', source:'osm', paint:{ 'raster-saturation':-0.88, 'raster-contrast':0.08, 'raster-opacity':0.46 } }]
      },
      center,
      zoom: Number(el.dataset.zoom || 15),
      interactive: true,
      attributionControl: false
    });
    map.scrollZoom.disable();
    map.boxZoom.disable();
    map.doubleClickZoom.disable();
    map.dragPan.disable();
    map.on('load', () => {
      el.classList.add('map-live');
      map.addSource('relations', {
        type:'geojson',
        data:{ type:'FeatureCollection', features:relations.map(([a,b]) => {
          const from = coord(a);
          const to = coord(b);
          return from && to ? { type:'Feature', geometry:{ type:'LineString', coordinates:[from, to] }, properties:{} } : null;
        }).filter(Boolean) }
      });
      map.addLayer({ id:'relations', type:'line', source:'relations', paint:{ 'line-color':'#1936b3', 'line-opacity':.62, 'line-width':2, 'line-dasharray':[2,2] } });
      for(const p of points){
        const marker = document.createElement('div');
        marker.className = 'person-marker' + (p.accent ? ' accent' : '') + (p.side === 'left' ? ' left' : '');
        marker.innerHTML = '<span class="pin-dot"></span><span class="pin-line"></span><span class="pin-card"><span class="pin-name">' + p.name + '</span><span class="pin-meta">' + p.meta + '</span></span>';
        marker.title = p.name;
        new maplibregl.Marker({ element: marker }).setLngLat(p.coord).addTo(map);
      }
      setTimeout(() => map.resize(), 300);
    });
    document.getElementById('deck')?.addEventListener('transitionend', () => map.resize());
    const zoomIn = panel?.querySelector('[data-map-ctrl="zoom-in"]');
    const zoomOut = panel?.querySelector('[data-map-ctrl="zoom-out"]');
    const drag = panel?.querySelector('[data-map-ctrl="drag"]');
    zoomIn?.addEventListener('click', (event) => { event.stopPropagation(); map.zoomIn(); });
    zoomOut?.addEventListener('click', (event) => { event.stopPropagation(); map.zoomOut(); });
    drag?.addEventListener('click', (event) => {
      event.stopPropagation();
      const active = drag.classList.toggle('active');
      drag.setAttribute('aria-pressed', active ? 'true' : 'false');
      drag.textContent = active ? 'DRAG ON' : 'DRAG';
      if(active) map.dragPan.enable(); else map.dragPan.disable();
    });
  }
  window.addEventListener('DOMContentLoaded', () => setTimeout(initSwissMap, 500));
})();
</script>
```

## Visual checks

- The left cards' total height must align with the right map card; don't let it float halfway up.
- The map title and control buttons must not overlap each other; pin cards must not cover the top-right control area.
- Marker cards must show at least the place name; `meta` is only a short tag.
- Don't be stingy with words on the left relation cards; each card should have one complete explanatory sentence.
- If the map fails to load, the static fallback must remain readable.
