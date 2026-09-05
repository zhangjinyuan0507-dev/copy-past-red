// 图像矩形框选工具 主逻辑（app.js）
const cv = document.getElementById('cv');
const ctx = cv.getContext('2d');
const leftEl = document.getElementById('canvasWrap');

let bgFiles = [], curIdx = -1, imgPlacements = {};
let bg = null, placements = [], vehImgs = {}, vehIndex = 0;
let selected = -1, drag = null, zoom = 1, baseZoom = 1, pan = null, pending = null, tx = 0, ty = 0, resize = null, rotDrag = null, bgCanvas = null, plan = null, savedMap = {}, dirtyMap = {}, manualType = -1, defSize = 0.06, defRot = 0;
let hideLabels = false, saveRoot = null;
const CLS = ['car1','car2','car3','car4'];
const state = { size:0.06, bright:0.8, contrast:1, blur:0.2, rot:0 };

function loadImage(src){ return new Promise(res=>{ const i=new Image(); i.onload=()=>res(i); i.onerror=()=>res(null); i.src=src; }); }
async function initVehicles(){ for (let i=0;i<VEHICLES.length;i++){ const im=await loadImage(VEHICLES[i].src); if(im) vehImgs[i]=im; } }
function setStatus(t){ document.getElementById('stem').textContent = t; }
function setSaveStatus(t){ document.getElementById('saveStatus').textContent = t; }
function markDirty(){ if(curIdx>=0) dirtyMap[curIdx]=true; showSaveStatus(); }
function pendingCount(){ let p=0; for(let i=0;i<bgFiles.length;i++){ const has=(i===curIdx)?placements:(imgPlacements[i]||[]); if(has.length && (dirtyMap[i]||!savedMap[i])) p++; } return p; }
function showSaveStatus(extra){
  const el=document.getElementById('saveStatus'); if(!el) return;
  const st = savedMap[curIdx] ? '已保存' : '未保存';
  const savedN = Object.keys(savedMap).filter(k=>savedMap[k]).length;
  let t='当前图片状态：'+st+'（'+placements.length+' 个框）';
  if(bgFiles.length) t+=' · 已存 '+savedN+'/'+bgFiles.length+' 张';
  t+=' · 待保存 '+pendingCount()+' 张';
  if(extra) t+=' · '+extra;
  el.textContent=t;
}
function saveProgress(t){ document.getElementById('saveStatus').textContent=t; }
function clampz(v,a,b){ return Math.max(a,Math.min(b,v)); }
function fmtN(v){ return Number(v).toFixed(2); }
function shareName(){ return bg ? bg.name.replace(/\.[^.]+$/,'') : 'img'; }

// ===== 视图 =====
function updateView(){
  if(!bg) return;
  cv.style.width = bg.naturalWidth + 'px'; cv.style.height = bg.naturalHeight + 'px';
  cv.style.transform = 'translate('+tx+'px,'+ty+'px) scale('+zoom+')';
  const zl=document.getElementById('v_zoom'); if(zl) zl.textContent=Math.round(100*zoom/baseZoom)+'%';
}
function centerView(){ const cw=leftEl.clientWidth, ch=leftEl.clientHeight; tx=(cw-bg.naturalWidth*zoom)/2; ty=(ch-bg.naturalHeight*zoom)/2; updateView(); }
function fitZoom(){ const cw=leftEl.clientWidth, ch=leftEl.clientHeight; zoom=bg?clampz(Math.min(cw/bg.naturalWidth,ch/bg.naturalHeight),0.05,64):1; baseZoom=zoom; centerView(); }
function wheelZoom(e){ if(!bg) return; e.preventDefault(); const lr=leftEl.getBoundingClientRect(); const mx=e.clientX-lr.left, my=e.clientY-lr.top; const oldZoom=zoom; const factor=Math.exp(-e.deltaY*0.0016); const nz=Math.min(64, Math.max(0.05, oldZoom*factor)); tx=mx-(mx-tx)*(nz/oldZoom); ty=my-(my-ty)*(nz/oldZoom); zoom=nz; updateView(); }
function imgPoint(e){ const r=cv.getBoundingClientRect(); return [(e.clientX-r.left)*(cv.width/r.width),(e.clientY-r.top)*(cv.height/r.height)]; }
function updateFileInfo(){ if(!bg) return; document.getElementById('fileInfo').textContent = bg.name+'   '+bg.naturalWidth+'x'+bg.naturalHeight+'px'; document.getElementById('bgIdx').textContent=(curIdx+1)+'/'+bgFiles.length; }
function updateImgSel(){ const sel=document.getElementById('imgSel'); sel.innerHTML=''; bgFiles.forEach((f,i)=>{ const o=document.createElement('option'); o.value=i; o.textContent=f.name; if(i===curIdx)o.selected=true; sel.appendChild(o); }); }

// ===== 几何 =====
function aabb(cx,cy,w,h,scale,rotDeg){
  const sw=w*scale/2, sh=h*scale/2, rad=rotDeg*Math.PI/180, c=Math.cos(rad), s=Math.sin(rad), xs=[], ys=[];
  for (const [px,py] of [[-sw,-sh],[sw,-sh],[sw,sh],[-sw,sh]]){ xs.push(cx+px*c-py*s); ys.push(cy+px*s+py*c); }
  return [Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)];
}
function aabbHit(x,y){
  for (let i=placements.length-1;i>=0;i--){ const p=placements[i], v=vehImgs[p.vi]; if(!v) continue;
    const [x0,y0,x1,y1]=aabb(p.x,p.y,v.naturalWidth,v.naturalHeight,p.size,p.rot);
    if (x>=x0-6&&x<=x1+6&&y>=y0-6&&y<=y1+6) return i; }
  return -1;
}
function selBox(){
  if(!(selected>=0&&placements[selected])) return null;
  const p=placements[selected], v=vehImgs[p.vi]; if(!v) return null;
  const [x0,y0,x1,y1]=aabb(p.x,p.y,v.naturalWidth,v.naturalHeight,p.size,p.rot);
  return {p,x0,y0,x1,y1,v};
}
function handles(){
  const b=selBox(); if(!b) return null;
  const R=Math.max(b.v.naturalWidth,b.v.naturalHeight)*b.p.size/2 + 24;
  const ang=(b.p.rot+90)*Math.PI/180;
  return {corners:[[b.x0,b.y0],[b.x1,b.y0],[b.x0,b.y1],[b.x1,b.y1]], rot:{x:b.p.x+R*Math.cos(ang), y:b.p.y+R*Math.sin(ang)}, b};
}

// ===== 渲染（软融合 + 亮度对齐背景 + 边缘羽化）=====
function sigmaRGB(d,i){ return 0.299*d[i]+0.587*d[i+1]+0.114*d[i+2]; }
function alphaBlur(arr, w, h){ // 3x3 box blur 作用于 RGBA，软化车身内容与边缘
  const a0=Array.from(arr); const out=arr.slice();
  for(let y=0;y<h;y++){ for(let x=0;x<w;x++){ let sr=0,sg=0,sb=0,sa=0,c=0;
    for(let dy=-1;dy<=1;dy++){ for(let dx=-1;dx<=1;dx++){ const yy=y+dy, xx=x+dx; if(xx>=0&&xx<w&&yy>=0&&yy<h){ const idx=(yy*w+xx)*4; sr+=a0[idx]; sg+=a0[idx+1]; sb+=a0[idx+2]; sa+=a0[idx+3]; c++; } } }
    const o=(y*w+x)*4; out[o]=Math.round(sr/c); out[o+1]=Math.round(sg/c); out[o+2]=Math.round(sb/c); out[o+3]=Math.round(sa/c); } }
  return out;
}
function pasteVehicleSoft(g, bctx, W, H, p, v){
  const w=Math.max(1,Math.round(v.naturalWidth*p.size)), h=Math.max(1,Math.round(v.naturalHeight*p.size));
  const ov=document.createElement('canvas'); ov.width=w; ov.height=h;
  const octx=ov.getContext('2d'); octx.drawImage(v,0,0,w,h);
  const im=octx.getImageData(0,0,w,h), d=im.data;
  // 车辆像素统计（alpha>20）
  let vS=0,vS2=0,vn=0;
  for(let i=0;i<d.length;i+=4){ if(d[i+3]>20){ const l=sigmaRGB(d,i); vS+=l; vS2+=l*l; vn++; } }
  const vMean=vn? vS/vn : 128, vStd=vn? Math.sqrt(Math.max(0,vS2/vn-vMean*vMean)) : 1;
  // 背景局部统计（中心附近）
  const R=Math.max(w,h)+14;
  const bx=Math.max(0,Math.min(W, Math.round(p.x)-R)), by=Math.max(0,Math.min(H, Math.round(p.y)-R));
  const bw=Math.min(W, Math.round(p.x)+R)-bx, bh=Math.min(H, Math.round(p.y)+R)-by;
  let bMean=vMean, bStd=vStd;
  if(bw>2&&bh>2){ const bd=bctx.getImageData(bx,by,bw,bh).data; let bS=0,bS2=0,bn=0;
    for(let i=0;i<bd.length;i+=4){ const l=sigmaRGB(bd,i); bS+=l; bS2+=l*l; bn++; }
    bMean=bn? bS/bn : vMean; bStd=bn? Math.sqrt(Math.max(0,bS2/bn-bMean*bMean)) : vStd; }
  // 对齐：保留车辆自身对比(缩放为背景std*p.contrast)，亮度中心比背景低 (1-p.bright)*std（越大越暗调）
  const tgtStd=Math.max(0.05, p.contrast*bStd), center=bMean-(1-p.bright)*bStd;
  const ratio=(vStd>1e-3)? tgtStd/vStd : 1;
  for(let i=0;i<d.length;i+=4){ const l=sigmaRGB(d,i); let nv=(l-vMean)*ratio+center; nv=Math.max(0,Math.min(255,nv)); d[i]=d[i+1]=d[i+2]=nv; }
  // 羽化边缘（按 p.blur 次数做 box 模糊）
  let a=d; const passes=Math.max(0,Math.min(6,Math.round(p.blur)));
  for(let k=0;k<passes;k++){ a=alphaBlur(a,w,h); }
  im.data.set(a);
  octx.putImageData(im,0,0);
  // 旋转贴到主画布
  g.save(); g.translate(p.x,p.y); g.rotate(p.rot*Math.PI/180); g.drawImage(ov,-w/2,-h/2,w,h); g.restore();
}
function renderScene(g, withBoxes, bgImg, pl){
  const W=bgImg.naturalWidth, H=bgImg.naturalHeight;
  if(!bgCanvas || bgCanvas.width!==W || bgCanvas.height!==H){ bgCanvas=document.createElement('canvas'); bgCanvas.width=W; bgCanvas.height=H; }
  const bctx=bgCanvas.getContext('2d'); bctx.clearRect(0,0,W,H); bctx.drawImage(bgImg,0,0);
  g.clearRect(0,0,W,H); g.drawImage(bgImg,0,0);
  for (const p of pl){ const v=vehImgs[p.vi]; if(!v) continue; pasteVehicleSoft(g,bctx,W,H,p,v); }
  if (withBoxes){ for (let i=0;i<pl.length;i++){ const p=pl[i], v=vehImgs[p.vi]; if(!v) continue;
    const [x0,y0,x1,y1]=aabb(p.x,p.y,v.naturalWidth,v.naturalHeight,p.size,p.rot);
    g.strokeStyle = i===selected ? '#ffff00' : 'rgba(0,255,0,0.4)'; g.lineWidth = i===selected?2:1;
    g.strokeRect(x0,y0,x1-x0,y1-y0); } }
}
function redraw(){
  if(!bg) return;
  renderScene(ctx, !hideLabels, bg, placements);
  const h = handles();
  if(h && !hideLabels){
    ctx.fillStyle='#ffffff'; ctx.strokeStyle='#ffffff'; ctx.lineWidth=1;
    for (const hx of h.corners) ctx.fillRect(hx[0]-4, hx[1]-4, 8, 8);
    ctx.beginPath(); ctx.arc(h.rot.x, h.rot.y, 7, 0, Math.PI*2); ctx.stroke();
    ctx.beginPath(); ctx.arc(h.rot.x, h.rot.y, 3, 0, Math.PI*2); ctx.fill();
    const w=Math.round(h.b.x1-h.b.x0), hh=Math.round(h.b.y1-h.b.y0);
    const txt = w+'×'+hh+'px · 像素数'+(w*hh);
    ctx.font='12px sans-serif'; ctx.textBaseline='top';
    const tw=ctx.measureText(txt).width;
    const lx=h.b.x0, ly=Math.max(0,h.b.y0-18);
    ctx.fillStyle='rgba(0,0,0,0.55)'; ctx.fillRect(lx, ly, tw+8, 16);
    ctx.fillStyle='#9fe3ff'; ctx.fillText(txt, lx+4, ly+2);
  }
  setStatus('第 '+(curIdx+1)+'/'+bgFiles.length+' 张  车辆 '+placements.length+'  选中 '+(selected+1)+'  '+bg.naturalWidth+'x'+bg.naturalHeight);
  updateInfo(); updateSizeLabel(); updateStats();
}

// ===== 信息 =====
function updateSizeLabel(){
  const c=(selected>=0&&placements[selected])?{v:vehImgs[placements[selected].vi],size:placements[selected].size,rot:placements[selected].rot}:{v:vehImgs[vehIndex],size:state.size,rot:state.rot};
  if(!c.v){ document.getElementById('v_size').textContent='—'; return; }
  const [x0,y0,x1,y1]=aabb(0,0,c.v.naturalWidth,c.v.naturalHeight,c.size,c.rot);
  document.getElementById('v_size').textContent=Math.round(x1-x0)+'x'+Math.round(y1-y0)+'px';
}
function pxbox(p,v){ const [x0,y0,x1,y1]=aabb(p.x,p.y,v.naturalWidth,v.naturalHeight,p.size,p.rot); return [Math.round(x0),Math.round(y0),Math.round(x1),Math.round(y1)]; }
function updateInfo(){
  const box=document.getElementById('infoBox');
  if(!(selected>=0&&placements[selected])){ box.innerHTML='（选中车辆后显示）'; return; }
  const p=placements[selected], v=vehImgs[p.vi]; if(!v){ box.innerHTML='—'; return; }
  const [x0,y0,x1,y1]=pxbox(p,v); const w=x1-x0,h=y1-y0;
  box.innerHTML='<b>#'+(selected+1)+' '+CLS[p.vi]+'（'+VEHICLES[p.vi].name+'）</b>'+
    ' <button class="del" onclick="deleteSelected()">✕</button><br>'+
    '<b>像素 x</b>：'+x0+' ~ '+x1+'<br><b>像素 y</b>：'+y0+' ~ '+y1+'<br>'+
    '<b>宽×高</b>：'+w+'×'+h+' px<br><b>中心</b>：('+Math.round(p.x)+', '+Math.round(p.y)+')<br>'+
    '<b>像素数</b>：'+(w*h).toFixed(1);
}
function deleteSelected(){ if(selected>=0){ placements.splice(selected,1); selected=-1; drag=null; resize=null; rotDrag=null; redraw(); markDirty(); } }

// ===== 参数 =====
function lastParams(){ return {size:defSize,bright:0.8,contrast:1,blur:0.2,rot:defRot}; }
function setSlider(id,vid,v){ document.getElementById(id).value=v; document.getElementById(vid).textContent=fmtN(v); }
function setSlidersFrom(p){
  setSlider('r_size','v_size',p.size);setSlider('r_bright','v_bright',p.bright);setSlider('r_contrast','v_contrast',p.contrast);setSlider('r_blur','v_blur',p.blur);setSlider('r_rot','v_rot',p.rot); updateSizeLabel(); }
function setVeh(i){ vehIndex=i; manualType=i; const s=document.getElementById('vehSel'); if(s) s.value=String(i); updatePlan(); }
function bindSlider(id,vid,key,fmt){
  const el=document.getElementById(id), lab=document.getElementById(vid);
  el.addEventListener('input',()=>{ const v=parseFloat(el.value); lab.textContent=fmt(v); if(key==='size') defSize=v; if(key==='rot') defRot=v; if(selected>=0&&placements[selected]) placements[selected][key]=v; redraw(); });
  lab.textContent=fmt(parseFloat(el.value));
}

// ===== 交互 =====
function updateStats(){
  const el=document.getElementById('statsInfo'); if(!el||!bgFiles) return;
  const tot=[0,0,0,0];
  placements.forEach(p=>{ if(p.vi>=0&&p.vi<4) tot[p.vi]++; });
  for(let i=0;i<bgFiles.length;i++){ if(i===curIdx) continue; const pl=imgPlacements[i]||[]; pl.forEach(p=>{ if(p.vi>=0&&p.vi<4) tot[p.vi]++; }); }
  const total=tot.reduce((s,v)=>s+v,0);
  const col=['#3a7bd5','#2f9e6f','#e8910c','#b05ce8'];
  let html='<div class="stats">';
  for(let i=0;i<4;i++){
    const c=tot[i], w=total>0 ? (c/total*100) : 0, pct=w;
    html+='<div class="srow"><span class="slab">'+CLS[i]+'</span>'+
      '<span class="barwrap"><span class="bar" style="width:'+w.toFixed(1)+'%;background:'+col[i]+'"></span></span>'+
      '<span class="sval">'+c+' · '+pct.toFixed(1)+'%</span></div>';
  }
  html+='<div class="stotal">总目标 '+total+' 个</div></div>';
  el.innerHTML=html;
}
function globalCounts(){ const tot=[0,0,0,0]; placements.forEach(p=>{ if(p.vi>=0&&p.vi<4) tot[p.vi]++; }); for(let i=0;i<bgFiles.length;i++){ if(i===curIdx) continue; const pl=imgPlacements[i]||[]; pl.forEach(p=>{ if(p.vi>=0&&p.vi<4) tot[p.vi]++; }); } return tot; }
function recommendType(){ const tot=globalCounts(); const mn=Math.min.apply(null,tot); const cands=[]; for(let i=0;i<4;i++) if(tot[i]===mn) cands.push(i); return cands[Math.floor(Math.random()*cands.length)]; }
function genPlan(){ plan={count:2+Math.floor(Math.random()*5)}; updatePlan(); }
function updatePlan(){
  const el=document.getElementById('planInfo'); if(!el||!plan) return;
  const n=plan.count, cur=placements.length;
  let s='本图建议 <b>'+n+'</b> 辆（按全图占比自动平衡车型，目标每种约25%）';
  s+='<br>已放 <b>'+cur+'</b>/'+n;
  if(manualType>=0){ s+=' · <b>已手动选 '+CLS[manualType]+'</b>（下一辆生效，之后回自动）'; }
  else if(cur<n){ const r=recommendType(); s+=' · 下一个：<b>'+CLS[r]+'</b>（最少占比，补齐平衡）'; }
  else s+=' · <b>✓ 已完成</b>';
  el.innerHTML=s;
}
function placeVehicleAt(ix,iy,rot){
  let vi;
  if(manualType>=0){ vi=manualType; manualType=-1; const s=document.getElementById('vehSel'); if(s) s.value='-1'; }
  else vi=recommendType();
  const np=Object.assign({vi:vi,x:ix,y:iy,rot:rot},lastParams());
  placements.push(np); selected=placements.length-1; setSlidersFrom(np); redraw(); updatePlan(); markDirty();
}
function onDown(e){
  if(e.button===2){ pan={baseTx:tx,baseTy:ty,mx:e.clientX,my:e.clientY}; return; }
  if(e.button!==0) return;
  const [ix,iy]=imgPoint(e);
  // 手柄优先：选中车上的角(缩放) / 旋转点
  const h=handles();
  if(h){
    for (const cxy of h.corners){ if(Math.hypot(ix-cxy[0],iy-cxy[1])<11){ resize={index:selected,startDist:Math.hypot(ix-h.b.p.x,iy-h.b.p.y),startSize:h.b.p.size}; pending=null; markDirty(); return; } }
    if(Math.hypot(ix-h.rot.x,iy-h.rot.y)<12){ rotDrag={index:selected}; pending=null; markDirty(); return; }
  }
  const hit=aabbHit(ix,iy);
  if(hit>=0){ selected=hit; setSlidersFrom(placements[hit]); drag={index:hit,ox:placements[hit].x-ix,oy:placements[hit].y-iy}; pending=null; markDirty(); redraw(); }
  else pending={ix,iy,clientX:e.clientX,clientY:e.clientY};
}
function onMove(e){
  const [ix,iy]=imgPoint(e);
  if(pan){ tx=pan.baseTx+(e.clientX-pan.mx); ty=pan.baseTy+(e.clientY-pan.my); updateView(); return; }
  if(resize){ const p=placements[resize.index]; const d=Math.hypot(ix-p.x,iy-p.y); const f=d/Math.max(1,resize.startDist); p.size=clampz(resize.startSize*f,0.005,0.9); defSize=p.size; redraw(); return; }
  if(rotDrag){ const p=placements[rotDrag.index]; p.rot=Math.atan2(iy-p.y,ix-p.x)*180/Math.PI-90; defRot=p.rot; redraw(); return; }
  if(drag){ const p=placements[drag.index]; p.x=ix-drag.ox; p.y=iy-drag.oy; redraw(); return; }
  if(pending&&(Math.abs(e.clientX-pending.clientX)+Math.abs(e.clientY-pending.clientY)>6)){ selected=-1; pan={baseTx:tx,baseTy:ty,mx:e.clientX,my:e.clientY}; pending=null; }
}
function onUp(){ if(pan){pan=null;return;} if(drag){drag=null;return;} if(resize){resize=null;return;} if(rotDrag){rotDrag=null;return;} if(pending){ placeVehicleAt(pending.ix,pending.iy,0); pending=null; } }

// ===== 多图 =====
function saveCurrentPlacements(){ if(curIdx>=0) imgPlacements[curIdx]=placements.slice(); }
function loadCurrent(){
  if(curIdx<0||curIdx>=bgFiles.length) return;
  bg=bgFiles[curIdx].img; cv.width=bg.naturalWidth; cv.height=bg.naturalHeight;
  placements=imgPlacements[curIdx]||[]; selected=-1; drag=null; pan=null; pending=null; resize=null; rotDrag=null; 
  fitZoom(); redraw(); updateFileInfo(); updateImgSel();
  showSaveStatus();
  genPlan();
}
function goto(delta){ const n=clampz(curIdx+delta,0,bgFiles.length-1); if(n===curIdx) return; saveCurrentPlacements(); curIdx=n; loadCurrent(); }
function jumpTo(i){ const n=clampz(i,0,bgFiles.length-1); if(n===curIdx) return; saveCurrentPlacements(); curIdx=n; loadCurrent(); }

// ===== 保存/导出 =====
function buildLabels(bgImg,pl){
  const W=bgImg.naturalWidth,H=bgImg.naturalHeight, stem=bgImg.name.replace(/\.[^.]+$/,'');
  let voc='<?xml version="1.0" encoding="utf-8"?>\n<annotation>\n  <filename>'+stem+'_composite.png</filename>\n  <size><width>'+W+'</width><height>'+H+'</height><depth>1</depth></size>\n';
  for(const p of pl){ const v=vehImgs[p.vi]; if(!v) continue; const [x0,y0,x1,y1]=aabb(p.x,p.y,v.naturalWidth,v.naturalHeight,p.size,p.rot);
    const xx0=Math.max(0,x0),yy0=Math.max(0,y0),xx1=Math.min(W,x1),yy1=Math.min(H,y1); if(xx1<=xx0||yy1<=yy0) continue;
    voc+='  <object><name>'+CLS[p.vi]+'</name><bndbox><xmin>'+Math.round(xx0)+'</xmin><xmax>'+Math.round(xx1)+'</xmax><ymin>'+Math.round(yy0)+'</ymin><ymax>'+Math.round(yy1)+'</ymax></bndbox></object>\n'; }
  voc+='</annotation>\n';
  return {stem,voc};
}
function dataURLToBlob(u){ try{ const [head, b64]=u.split(','); const mm=head.match(/data:(.*?)(;|$)/); const bin=atob(b64); const arr=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) arr[i]=bin.charCodeAt(i); return new Blob([arr],{type:mm?mm[1]:'image/png'}); }catch(e){ return null; } }
function compositeBlob(bgImg,pl){
  const c=document.createElement('canvas'); c.width=bgImg.naturalWidth; c.height=bgImg.naturalHeight;
  const g=c.getContext('2d');
  renderScene(g,false,bgImg,pl);
  return new Promise(res=>{
    try{
      c.toBlob(b=>{ if(b && b.size>0) res(b); else res(dataURLToBlob(c.toDataURL('image/png'))); }, 'image/png');
    }catch(e){
      try{ res(dataURLToBlob(c.toDataURL('image/png'))); }catch(e2){ res(null); }
    }
  });
}
async function writeFile(dir,name,data){ const fh=await dir.getFileHandle(name,{create:true}); const ws=await fh.createWritable(); await ws.write(data); await ws.close(); }
function download(name,blob){
  try{
    const a=document.createElement('a'); const url=URL.createObjectURL(blob);
    a.href=url; a.download=name; document.body.appendChild(a); a.click();
    setTimeout(()=>{ URL.revokeObjectURL(url); a.remove(); }, 1200);
  }catch(e){ alert('下载失败：'+(e&&e.message||e)); }
}
function setDirInfo(){ document.getElementById('dirInfo').innerHTML='已选择: <b class="fname">'+saveRoot.name+'</b> （点击更改）'; }
async function pickDir(){ if(!window.showDirectoryPicker){ alert('该浏览器不支持文件夹选择'); return; } try{ saveRoot=await window.showDirectoryPicker({mode:'readwrite'}); setDirInfo(); }catch(err){} }
async function ensureRoot(){ if(saveRoot) return saveRoot; if(!window.showDirectoryPicker) return null; try{ saveRoot=await window.showDirectoryPicker({mode:'readwrite'}); setDirInfo(); return saveRoot; }catch(err){ return null; } }
function exportJSON(){ if(!bg) return; const data={image:bg.name,width:bg.naturalWidth,height:bg.naturalHeight,boxes:placements.map(p=>({class:CLS[p.vi],cx:Math.round(p.x),cy:Math.round(p.y),rot:p.rot,size:p.size,bright:p.bright,contrast:p.contrast,blur:p.blur}))}; download(shareName()+'.json',new Blob([JSON.stringify(data,null,2)],{type:'application/json'})); }
function validBlob(b){ return b && b.size>0; }
async function saveCurrent(){
  if(!bg){ alert('先加载背景图'); return; }
  try{
    const png=await compositeBlob(bg,placements); const {stem,voc}=buildLabels(bg,placements);
    if(!validBlob(png)){ alert('图片导出失败（画布可能被污染，或浏览器不支持），请刷新重试。'); return; }
    saveProgress('正在保存当前 「'+stem+'」…');
    const root=await ensureRoot();
    if(root){ try{ const imgDir=await root.getDirectoryHandle('images',{create:true}); const xmlDir=await root.getDirectoryHandle('xml',{create:true});
      await writeFile(imgDir,stem+'_composite.png',png); await writeFile(xmlDir,stem+'.xml',new Blob([voc],{type:'text/xml'}));
      savedMap[curIdx]=true; dirtyMap[curIdx]=false; showSaveStatus('本张已保存 → images/+xml/'); }
      catch(err){ if(err&&err.name!=='AbortError'){ alert('写入文件夹失败：'+(err.message||err)+'。已改为下载。'); download(stem+'_composite.png',png); download(stem+'.xml',new Blob([voc],{type:'text/xml'})); savedMap[curIdx]=true; dirtyMap[curIdx]=false; showSaveStatus('已下载 无框图+xml（文件夹写入失败回退）'); } } }
    else { download(stem+'_composite.png',png); download(stem+'.xml',new Blob([voc],{type:'text/xml'})); savedMap[curIdx]=true; dirtyMap[curIdx]=false; showSaveStatus('已下载 无框图+xml（需本地服务才能“存文件夹”）'); }
  } catch(err){ alert('保存出错：'+(err&&err.message||err)); }
}
async function saveAll(){
  if(!bgFiles.length){ alert('先加载背景图'); return; }
  try{
    saveCurrentPlacements();
    const items=[]; for(let i=0;i<bgFiles.length;i++){ const pl=imgPlacements[i]||[]; if(pl.length && (dirtyMap[i]||!savedMap[i])) items.push({idx:i,bgImg:bgFiles[i].img,pl,stem:bgFiles[i].img.name.replace(/\.[^.]+$/,'')}); }
    if(!items.length){ alert('没有需要保存的图（都已保存且未修改）'); return; }
    const root=await ensureRoot();
    if(root){ try{ const imgDir=await root.getDirectoryHandle('images',{create:true}); const xmlDir=await root.getDirectoryHandle('xml',{create:true});
      for(let k=0;k<items.length;k++){ const it=items[k];
        saveProgress('正在保存 '+(k+1)+'/'+items.length+'：「'+it.stem+'」…');
        const png=await compositeBlob(it.bgImg,it.pl); const {voc}=buildLabels(it.bgImg,it.pl);
        await writeFile(imgDir,it.stem+'_composite.png',png); await writeFile(xmlDir,it.stem+'.xml',new Blob([voc],{type:'text/xml'}));
        savedMap[it.idx]=true; dirtyMap[it.idx]=false;
      }
      showSaveStatus('本次增量保存完成，共 '+items.length+' 张'); }
      catch(err){ if(err&&err.name!=='AbortError'){ alert('写入文件夹失败：'+(err.message||err)+'。已改为逐个下载。'); for(const it of items){ const png=await compositeBlob(it.bgImg,it.pl); const {voc}=buildLabels(it.bgImg,it.pl); download(it.stem+'_composite.png',png); download(it.stem+'.xml',new Blob([voc],{type:'text/xml'})); savedMap[it.idx]=true; dirtyMap[it.idx]=false; } showSaveStatus('已下载新增 '+items.length+' 张（文件夹写入失败回退）'); } } }
    else { for(let k=0;k<items.length;k++){ const it=items[k]; saveProgress('正在保存 '+(k+1)+'/'+items.length+'：「'+it.stem+'」…'); const png=await compositeBlob(it.bgImg,it.pl); const {voc}=buildLabels(it.bgImg,it.pl); download(it.stem+'_composite.png',png); download(it.stem+'.xml',new Blob([voc],{type:'text/xml'})); savedMap[it.idx]=true; dirtyMap[it.idx]=false; } showSaveStatus('已下载新增 '+items.length+' 张（需本地服务才能“存文件夹”）'); }
  } catch(err){ alert('保存出错：'+(err&&err.message||err)); }
}

// ===== 初始化 =====
function loadImageFiles(files){ const reads=Array.from(files).map(f=>new Promise(res=>{ const rd=new FileReader(); rd.onload=()=>{ const img=new Image(); img.onload=()=>{ img.name=f.name; res({name:f.name,img}); }; img.src=rd.result; }; rd.readAsDataURL(f); })); Promise.all(reads).then(list=>{ if(!list.length) return; bgFiles=list.filter(x=>x&&x.img); curIdx=0; imgPlacements={}; placements=[]; savedMap={}; dirtyMap={}; loadCurrent(); setStatus('已加载 '+bgFiles.length+' 张背景'); }); }
function handleDrop(e){
  e.preventDefault();
  const items = e.dataTransfer && e.dataTransfer.items ? Array.from(e.dataTransfer.items) : [];
  const entries = [];
  for (const it of items){ const en = it.webkitGetAsEntry ? it.webkitGetAsEntry() : null; if (en) entries.push(en); }
  if (!entries.length){ if(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) loadImageFiles(e.dataTransfer.files); return; }
  const files = [];
  const readEntry = (entry) => new Promise(res => {
    if (!entry){ res(); return; }
    if (entry.isFile){ entry.file(f=>{ files.push(f); res(); }, ()=>res()); }
    else if (entry.isDirectory){ const rd = entry.createReader(); const readBatch = ()=> rd.readEntries(batch=>{ if(batch.length){ batch.forEach(readEntry); readBatch(); } else res(); }, ()=>res()); readBatch(); }
    else res();
  });
  Promise.all(entries.map(readEntry)).then(()=>loadImageFiles(files));
}
function init(){
  document.getElementById('folderInput').addEventListener('change',e=>{ if(e.target.files.length) loadImageFiles(e.target.files); });
  document.getElementById('vehSel').addEventListener('change',e=>{ const v=parseInt(e.target.value); if(v>=0) setVeh(v); else { manualType=-1; updatePlan(); } });
  document.getElementById('fitBtn').addEventListener('click',fitZoom);
  document.getElementById('clear').addEventListener('click',()=>{ placements=[]; selected=-1; drag=null; resize=null; rotDrag=null;  redraw(); markDirty(); });
  document.getElementById('clear2').addEventListener('click',()=>{ placements=[]; selected=-1; drag=null; resize=null; rotDrag=null;  redraw(); markDirty(); });
  document.getElementById('hideLabels').addEventListener('change',e=>{ hideLabels=e.target.checked; redraw(); });
  document.getElementById('prev').addEventListener('click',()=>goto(-1));
  document.getElementById('next').addEventListener('click',()=>goto(1));
  document.getElementById('prev2').addEventListener('click',()=>goto(-1));
  document.getElementById('next2').addEventListener('click',()=>goto(1));
  document.getElementById('imgSel').addEventListener('change',e=>jumpTo(parseInt(e.target.value)));
  document.getElementById('replan').addEventListener('click',genPlan);
  document.getElementById('pickDir').addEventListener('click',pickDir);
  function flash(btn){ /* 轻提示：仅加一个短暂的按压缩放/反白（不改持久颜色） */ }
  document.getElementById('saveCur').addEventListener('click',()=>saveCurrent());
  document.getElementById('saveAll').addEventListener('click',()=>saveAll());
  document.getElementById('undo').addEventListener('click',()=>{ if(placements.length) placements.pop(); if(selected>=placements.length) selected=-1; drag=null; resize=null; rotDrag=null;  redraw(); markDirty(); });
  cv.addEventListener('mousedown',onDown); cv.addEventListener('mousemove',onMove); cv.addEventListener('mouseup',onUp);
  cv.addEventListener('contextmenu',e=>e.preventDefault()); cv.addEventListener('wheel',wheelZoom,{passive:false});
  window.addEventListener('dragover',e=>{ e.preventDefault(); });
  window.addEventListener('drop',handleDrop);
  bindSlider('r_size','v_size','size',fmtN); bindSlider('r_bright','v_bright','bright',fmtN); bindSlider('r_contrast','v_contrast','contrast',fmtN); bindSlider('r_blur','v_blur','blur',fmtN); bindSlider('r_rot','v_rot','rot',fmtN);
  document.addEventListener('keydown',e=>{ if(e.key>='1'&&e.key<='4') setVeh(parseInt(e.key)-1); else if(e.key==='z'){ if(placements.length) placements.pop(); redraw(); } else if(e.key==='c'||e.key==='C'){ placements=[]; redraw(); } else if(e.key==='s'||e.key==='S') saveCurrent(); else if(e.key==='ArrowLeft') goto(-1); else if(e.key==='ArrowRight') goto(1); else if(e.key==='Delete'||e.key==='Backspace'){ if(selected>=0){ e.preventDefault(); deleteSelected(); } } });
}
init();
initVehicles().then(()=>setStatus('车辆素材已加载。选择一张或多张背景图。'));
