(() => {
  const $ = id => document.getElementById(id);
  const ui = Object.fromEntries(['imageFile','addRegion','deleteRegion','instruction','bubbleCount','bubbleList','bubbleForm','eraseMode','editErase','whiteoutBrush','undoBrush','brushSize','textMode','regionShape','sourceText','translatedText','fillMode','fillColor','textColor','fontSize','padding','textFitStatus','fontFamily','boldText','uncertain','previewWhiteout','analyzePage','savePage','exportPng','saveProject','openProject','pageInfo','zoomOut','zoomIn','zoomValue','canvasViewport','canvasStage','pageCanvas','overlayCanvas','dropPrompt'].map(id => [id, $(id)]));
  const serverConfig = $('page-config') ? JSON.parse($('page-config').textContent) : null;
  const page = ui.pageCanvas.getContext('2d');
  const overlay = ui.overlayCanvas.getContext('2d');
  let image = null, imageData = '', fileName = 'page', bubbles = [], selected = -1, zoom = 1, action = null, nextId = 1, editingErase = false, brushing = false, sourcePixels = null, eraseCache = new WeakMap(), layoutCache = new WeakMap();
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const current = () => bubbles[selected];
  const setStatus = message => { ui.instruction.textContent = message; };

  function setImage(src, name) {
    return new Promise((resolve, reject) => {
      const loaded = new Image();
      loaded.onload = () => {
        if (loaded.naturalWidth * loaded.naturalHeight > 40000000) { reject(new Error('Image is too large for this editor (40 million pixels maximum).')); return; }
        image = loaded; imageData = src; fileName = name || 'page'; bubbles = []; selected = -1; nextId = 1;
        ui.pageCanvas.width = ui.overlayCanvas.width = image.naturalWidth;
        ui.pageCanvas.height = ui.overlayCanvas.height = image.naturalHeight;
        page.drawImage(image,0,0);
        sourcePixels = page.getImageData(0,0,image.naturalWidth,image.naturalHeight).data;
        eraseCache = new WeakMap(); layoutCache = new WeakMap();
        zoom = Math.min(1, Math.max(.2, (ui.canvasViewport.clientWidth - 90) / image.naturalWidth));
        ui.canvasStage.style.display = 'block'; ui.dropPrompt.style.display = 'none';
        ui.pageInfo.textContent = `${fileName} · ${image.naturalWidth} × ${image.naturalHeight}`;
        for (const id of ['addRegion','exportPng','saveProject','zoomOut','zoomIn']) ui[id].disabled = false;
        if (serverConfig) ui.savePage.disabled = false;
        updateZoom(); updateUi(); render(); resolve();
      };
      loaded.onerror = () => reject(new Error('Could not read this image.'));
      loaded.src = src;
    });
  }

  function updateZoom() {
    ui.canvasStage.style.width = `${Math.round(image.naturalWidth * zoom)}px`;
    ui.canvasStage.style.height = `${Math.round(image.naturalHeight * zoom)}px`;
    ui.zoomValue.textContent = `${Math.round(zoom * 100)}%`;
  }

  function lightSurfacePixel(x,y) {
    const i=(y*image.naturalWidth+x)*4, r=sourcePixels[i], g=sourcePixels[i+1], b=sourcePixels[i+2];
    return Math.min(r,g,b)>=95 && (r+g+b)/3>=175 && Math.max(r,g,b)-Math.min(r,g,b)<=155;
  }

  function whitePixel(x,y) {
    const i=(y*image.naturalWidth+x)*4, r=sourcePixels[i], g=sourcePixels[i+1], b=sourcePixels[i+2];
    return r>=225 && g>=225 && b>=225 && Math.max(r,g,b)-Math.min(r,g,b)<=35;
  }

  function detectedWhiteout(bubble,extended=false) {
    const key=[bubble.x,bubble.y,bubble.w,bubble.h,bubble.fill,bubble.fillMode,extended].join(':');
    const cached=eraseCache.get(bubble);
    if (cached?.key===key) return cached.value;
    const tintedCaption=bubble.erase.shape==='rectangle'&&bubble.fillMode==='auto';
    const surfacePixel=tintedCaption?lightSurfacePixel:whitePixel;
    const left=clamp(Math.floor(bubble.x-bubble.w*(tintedCaption ? .4 : 1)),0,image.naturalWidth-1);
    const top=clamp(Math.floor(bubble.y-bubble.h*(tintedCaption ? .7 : 1)),0,image.naturalHeight-1);
    const right=clamp(Math.ceil(bubble.x+bubble.w*(tintedCaption?1.4:2)),left+1,image.naturalWidth);
    const bottom=clamp(Math.ceil(bubble.y+bubble.h*(tintedCaption?1.2:extended?3.2:2)),top+1,image.naturalHeight);
    const width=right-left, height=bottom-top, count=width*height;
    if (count>3000000) { eraseCache.set(bubble,{key,value:null}); return null; }
    let seed=-1, best=Infinity;
    const cx=bubble.x+bubble.w/2, cy=bubble.y+bubble.h/2;
    for(let y=Math.max(top,Math.floor(bubble.y));y<Math.min(bottom,Math.ceil(bubble.y+bubble.h));y++)
      for(let x=Math.max(left,Math.floor(bubble.x));x<Math.min(right,Math.ceil(bubble.x+bubble.w));x++) {
        if (!surfacePixel(x,y)) continue;
        const score=(x-cx)**2+(y-cy)**2;
        if(score<best) { best=score; seed=(y-top)*width+x-left; }
      }
    const visited=new Uint8Array(count), queue=new Int32Array(count);
    const findComponent=start=>{
      const pixels=new Uint8Array(count);
      let head=0,tail=0,minX=width,minY=height,maxX=0,maxY=0;
      visited[start]=1; pixels[start]=1; queue[tail++]=start;
      while(head<tail) {
        const at=queue[head++], lx=at%width, ly=(at-lx)/width;
        minX=Math.min(minX,lx); maxX=Math.max(maxX,lx); minY=Math.min(minY,ly); maxY=Math.max(maxY,ly);
        const neighbors=[lx>0?at-1:-1,lx<width-1?at+1:-1,ly>0?at-width:-1,ly<height-1?at+width:-1];
        for(const next of neighbors) {
          if(next<0||visited[next]) continue;
          const nx=next%width,ny=(next-nx)/width;
          if(!surfacePixel(left+nx,top+ny)) continue;
          visited[next]=1;pixels[next]=1;queue[tail++]=next;
        }
      }
      return {pixels,tail,minX,minY,maxX,maxY};
    };
    const plausible=part=>{
      if(part.tail<Math.max(40,bubble.w*bubble.h*.08)) return false;
      const w=part.maxX-part.minX+1,h=part.maxY-part.minY+1;
      // A horizontal panel gutter can pass through an inaccurate AI rectangle.
      return !(w>=width*.8&&h<Math.max(24,bubble.h*.7)) && h>=Math.max(12,bubble.h*.25);
    };
    let chosen=seed>=0?findComponent(seed):null;
    if(!chosen||!plausible(chosen)) {
      chosen=null;
      const alternatives=[];
      for(let y=top;y<bottom;y++) for(let x=left;x<right;x++) {
        const at=(y-top)*width+x-left;
        if(visited[at]||!surfacePixel(x,y)) continue;
        const part=findComponent(at);
        if(!plausible(part)) continue;
        const mx=left+(part.minX+part.maxX)/2,my=top+(part.minY+part.maxY)/2;
        const distance=((mx-cx)/Math.max(1,bubble.w))**2+((my-cy)/Math.max(1,bubble.h))**2;
        alternatives.push({part,score:part.tail/(1+distance)});
      }
      alternatives.sort((a,b)=>b.score-a.score);
      chosen=alternatives[0]?.part||null;
    }
    if(!chosen) {
      if(!extended&&!tintedCaption) {
        const value=detectedWhiteout(bubble,true);
        eraseCache.set(bubble,{key,value}); return value;
      }
      eraseCache.set(bubble,{key,value:null}); return null;
    }
    const component=chosen.pixels,{minX,minY,maxX,maxY}=chosen;
    const relocated=(left+minX>bubble.x+bubble.w||left+maxX<bubble.x||top+minY>bubble.y+bubble.h||top+maxY<bubble.y);
    // Black lettering is a hole enclosed by the connected white bubble interior.
    const outside=new Uint8Array(count), edgeQueue=new Int32Array(count);
    let first=0,last=0;
    const addEdge=at=>{ if(!component[at]&&!outside[at]) { outside[at]=1; edgeQueue[last++]=at; } };
    for(let x=minX;x<=maxX;x++) { addEdge(minY*width+x); addEdge(maxY*width+x); }
    for(let y=minY;y<=maxY;y++) { addEdge(y*width+minX); addEdge(y*width+maxX); }
    while(first<last) {
      const at=edgeQueue[first++], lx=at%width, ly=(at-lx)/width;
      const neighbors=[lx>minX?at-1:-1,lx<maxX?at+1:-1,ly>minY?at-width:-1,ly<maxY?at+width:-1];
      for(const next of neighbors) if(next>=0&&!component[next]&&!outside[next]) { outside[next]=1; edgeQueue[last++]=next; }
    }
    const maskLeft=Math.max(0,minX-8), maskTop=Math.max(0,minY-8);
    const maskRight=Math.min(width-1,maxX+8), maskBottom=Math.min(height-1,maxY+8);
    const maskCanvas=document.createElement('canvas'); maskCanvas.width=maskRight-maskLeft+1; maskCanvas.height=maskBottom-maskTop+1;
    const maskContext=maskCanvas.getContext('2d'), pixels=maskContext.createImageData(maskCanvas.width,maskCanvas.height);
    const rgb=[1,3,5].map(start=>parseInt(bubble.fill.slice(start,start+2),16));
    const rowColors=[];
    for(let y=maskTop;y<=maskBottom;y++) {
      const samples=[[],[],[]];
      for(let x=maskLeft;x<=maskRight;x++) if(component[y*width+x]) {
        const at=((top+y)*image.naturalWidth+left+x)*4;
        for(let channel=0;channel<3;channel++) samples[channel].push(sourcePixels[at+channel]);
      }
      rowColors.push(samples[0].length?samples.map(values=>{values.sort((a,b)=>a-b);return values[Math.floor(values.length/2)];}):null);
    }
    for(let y=0;y<rowColors.length;y++) if(!rowColors[y]) {
      let nearest=null, distance=Infinity;
      for(let candidate=0;candidate<rowColors.length;candidate++) if(rowColors[candidate]&&Math.abs(candidate-y)<distance) {nearest=rowColors[candidate];distance=Math.abs(candidate-y);}
      rowColors[y]=nearest||rgb;
    }
    const nearWhite=(x,y,dx,dy)=>{
      for(let step=1;step<=18;step++) {
        const nx=x+dx*step, ny=y+dy*step;
        if(nx<0||nx>=width||ny<0||ny>=height) break;
        if(component[ny*width+nx]) return true;
      }
      return false;
    };
    for(let y=maskTop;y<=maskBottom;y++) for(let x=maskLeft;x<=maskRight;x++) {
      const at=y*width+x;
      const enclosed=x>=minX&&x<=maxX&&y>=minY&&y<=maxY&&!outside[at];
      if(!component[at]&&!enclosed) {
        const source=((top+y)*image.naturalWidth+left+x)*4;
        const r=sourcePixels[source], g=sourcePixels[source+1], b=sourcePixels[source+2];
        if(Math.max(r,g,b)>190||Math.max(r,g,b)-Math.min(r,g,b)>75) continue;
        const sides=Number(nearWhite(x,y,-1,0))+Number(nearWhite(x,y,1,0))+Number(nearWhite(x,y,0,-1))+Number(nearWhite(x,y,0,1));
        if(sides<(left+x===0?2:3)) continue;
      }
      const out=((y-maskTop)*maskCanvas.width+x-maskLeft)*4;
      const fill=bubble.fillMode==='manual'?rgb:rowColors[y-maskTop];
      pixels.data[out]=fill[0]; pixels.data[out+1]=fill[1]; pixels.data[out+2]=fill[2]; pixels.data[out+3]=255;
    }
    // A balloon clipped by the page edge has no white pixels beyond that edge
    // to enclose its first letters. Extend only rows with a broad white run.
    if(bubble.x<=1 && !tintedCaption && maskLeft===0) {
      for(let y=Math.max(maskTop,Math.floor(bubble.y-top-bubble.h*.2));y<=Math.min(maskBottom,Math.ceil(bubble.y-top+bubble.h*.75));y++) {
        let firstWhite=-1,lastWhite=-1;
        for(let x=0;x<Math.min(width,Math.ceil(bubble.w));x++) if(component[y*width+x]) {if(firstWhite<0) firstWhite=x;lastWhite=x;}
        if(firstWhite<0||lastWhite<Math.min(width-1,bubble.w*.55)) continue;
        const fill=rowColors[y-maskTop];
        for(let x=0;x<Math.min(maskCanvas.width,Math.round(bubble.w*.3));x++) {
          const out=((y-maskTop)*maskCanvas.width+x)*4;
          pixels.data[out]=fill[0];pixels.data[out+1]=fill[1];pixels.data[out+2]=fill[2];pixels.data[out+3]=255;
        }
      }
    }
    if(!tintedCaption) {
      const xStart=Math.max(maskLeft,Math.floor(bubble.x-left-bubble.w*.2));
      const xEnd=Math.min(maskRight,Math.ceil(bubble.x-left+bubble.w*1.2));
      const yStart=Math.max(maskTop,Math.floor(bubble.y-top-bubble.h*.3));
      const yEnd=Math.min(maskBottom,Math.ceil(bubble.y-top+bubble.h));
      const filled=(x,y)=>x>=maskLeft&&x<=maskRight&&y>=maskTop&&y<=maskBottom&&pixels.data[((y-maskTop)*maskCanvas.width+x-maskLeft)*4+3]===255;
      for(let y=yStart;y<=yEnd;y++) {
        let x=xStart;
        while(x<=xEnd) {
          if(filled(x,y)) {x++;continue;}
          const start=x;
          while(x<=xEnd&&!filled(x,y)) x++;
          const end=x-1, middle=Math.floor((start+end)/2);
          if(start<=xStart||x>xEnd||end-start+1>Math.min(45,bubble.w*.4)) continue;
          const nearVertical=direction=>{
            for(let step=1;step<=12;step++) if(filled(middle,y+direction*step)) return true;
            return false;
          };
          if(!nearVertical(-1)||!nearVertical(1)) continue;
          const fill=rowColors[y-maskTop];
          for(let gap=start;gap<=end;gap++) {
            const out=((y-maskTop)*maskCanvas.width+gap-maskLeft)*4;
            pixels.data[out]=fill[0];pixels.data[out+1]=fill[1];pixels.data[out+2]=fill[2];pixels.data[out+3]=255;
          }
        }
      }
    }
    maskContext.putImageData(pixels,0,0);
    const value={canvas:maskCanvas,pixels:pixels.data,rowColors,x:left+maskLeft,y:top+maskTop,w:maskCanvas.width,h:maskCanvas.height,relocated,region:{x:left+minX,y:top+minY,w:maxX-minX+1,h:maxY-minY+1}};
    eraseCache.set(bubble,{key,value}); return value;
  }

  function eraseOriginal(ctx,bubble) {
    if(bubble.eraseMode!=='manual') {
      const detected=detectedWhiteout(bubble);
      if(detected) { ctx.drawImage(detected.canvas,detected.x,detected.y); paintBrushStrokes(ctx,bubble); return; }
      // An uncertain AI region must not cover artwork with a guessed ellipse.
      paintBrushStrokes(ctx,bubble); return;
    }
    const {x,y,w,h,shape}=bubble.erase;
    const detected=bubble.fillMode==='auto'?detectedWhiteout(bubble):null;
    const row=detected?.rowColors[clamp(Math.round(bubble.erase.y+bubble.erase.h/2-detected.y),0,detected.h-1)];
    ctx.fillStyle=row?`rgb(${row.join(',')})`:bubble.fill; ctx.beginPath();
    if(shape==='ellipse') ctx.ellipse(x+w/2,y+h/2,w/2,h/2,0,0,Math.PI*2);
    else ctx.rect(x,y,w,h);
    ctx.fill();
    paintBrushStrokes(ctx,bubble);
  }

  function paintBrushStrokes(ctx,bubble) {
    ctx.save(); ctx.lineCap='round'; ctx.lineJoin='round';
    const detected=bubble.fillMode==='auto'?detectedWhiteout(bubble):null;
    for(const stroke of bubble.eraseStrokes) {
      if(!stroke.points.length) continue;
      const y=Math.round(stroke.points.reduce((sum,point)=>sum+point.y,0)/stroke.points.length);
      const row=detected?.rowColors[clamp(y-detected.y,0,detected.h-1)];
      const color=row?`rgb(${row.join(',')})`:bubble.fill;
      ctx.strokeStyle=color; ctx.fillStyle=color;
      ctx.lineWidth=stroke.size; ctx.beginPath(); ctx.moveTo(stroke.points[0].x,stroke.points[0].y);
      for(const point of stroke.points.slice(1)) ctx.lineTo(point.x,point.y);
      ctx.stroke();
      if(stroke.points.length===1) { const point=stroke.points[0]; ctx.beginPath(); ctx.arc(point.x,point.y,stroke.size/2,0,Math.PI*2); ctx.fill(); }
    }
    ctx.restore();
  }

  function textBox(bubble) {
    if(bubble.textMode==='manual') return bubble;
    const mask=detectedWhiteout(bubble);
    if(!mask) return bubble;
    const signature=[bubble.x,bubble.y,bubble.w,bubble.h,bubble.fill,bubble.translation,bubble.font,bubble.bold,bubble.fontSize,bubble.padding,bubbles.map(b=>`${b.x},${b.y},${b.w},${b.h}`).join(';')].join(':');
    const cached=layoutCache.get(bubble);
    if(cached?.key===signature) return cached.value;
    const hint=mask.relocated?mask.region:bubble;
    const cx=hint.x+hint.w/2, cy=hint.y+hint.h/2;
    const spread=bubble.w<110&&hasStackedPartner(bubble)? .8:.35;
    const left=Math.max(mask.x,Math.floor(hint.x-hint.w*spread)), top=Math.max(mask.y,Math.floor(hint.y-hint.h*spread));
    const right=Math.min(mask.x+mask.w,Math.ceil(hint.x+hint.w*(1+spread))), bottom=Math.min(mask.y+mask.h,Math.ceil(hint.y+hint.h*1.35));
    const width=right-left, heights=new Int32Array(Math.max(0,width));
    const candidateBuckets=new Map();
    for(let y=top;y<bottom;y++) {
      const stack=[];
      for(let col=0;col<=width;col++) {
        const x=left+col;
        let allowed=col<width;
        if(allowed) {
          const at=((y-mask.y)*mask.w+x-mask.x)*4;
          allowed=mask.pixels[at+3]===255;
          if(allowed) allowed=ownsPixel(bubble,x,y);
        }
        if(col<width) heights[col]=allowed?heights[col]+1:0;
        const height=col<width?heights[col]:0;
        while(stack.length&&heights[stack[stack.length-1]]>height) {
          const end=col, h=heights[stack.pop()], start=stack.length?stack[stack.length-1]+1:0, w=end-start;
          if(w<Math.max(12,hint.w*.3)||h<Math.max(12,hint.h*.3)) continue;
          const midX=left+(start+end)/2, midY=y-h/2;
          const distance=((midX-cx)/Math.max(1,hint.w))**2+((midY-cy)/Math.max(1,hint.h))**2;
          if(distance>(spread>.35?2:.7)) continue;
          const areaScore=w*h/(1+distance*.6);
          const box={x:left+start,y:y-h+1,w,h,areaScore};
          const bucket=[Math.floor(box.x/8),Math.floor(box.y/8),Math.floor(w/8),Math.floor(h/8)].join(':');
          if(areaScore>(candidateBuckets.get(bucket)?.areaScore||0)) candidateBuckets.set(bucket,box);
        }
        stack.push(col);
      }
    }
    const ranked=[...candidateBuckets.values()].sort((a,b)=>b.areaScore-a.areaScore);
    const minimum=(ranked[0]?.areaScore||0)*.35;
    const candidates=[...new Set([...ranked.slice(0,60),...ranked.filter(box=>box.areaScore>=minimum).sort((a,b)=>b.w-a.w).slice(0,40),...ranked.filter(box=>box.areaScore>=minimum).sort((a,b)=>b.h-a.h).slice(0,30)])];
    let best=null, bestScore=-1;
    for(const candidate of candidates) {
      const pad=Math.min(bubble.padding,candidate.w/5,candidate.h/5), availableWidth=candidate.w-2*pad, availableHeight=candidate.h-2*pad;
      let low=6,high=Math.min(160,Math.max(6,Number(bubble.fontSize)||40)), fitted=0;
      while(low<=high) {
        const size=Math.floor((low+high)/2);
        page.font=`${bubble.bold?'bold ':''}${size}px "${bubble.font}"`;
        const lines=linesFor(bubble.translation.trim(),page,availableWidth);
        if(lines.every(line=>page.measureText(line).width<=availableWidth)&&lines.length*size*1.15<=availableHeight) {fitted=size;low=size+1;}
        else high=size-1;
      }
      const score=fitted*100000+candidate.areaScore;
      if(score>bestScore) {bestScore=score;best=candidate;}
    }
    const inset=best?Math.min(4,Math.max(1,Math.floor(Math.min(best.w,best.h)*.025))):0;
    const value=best?{x:best.x+inset,y:best.y+inset,w:best.w-2*inset,h:best.h-2*inset}:bubble;
    layoutCache.set(bubble,{key:signature,value});
    return value;
  }

  function ownsPixel(bubble,x,y) {
    const cx=bubble.x+bubble.w/2, cy=bubble.y+bubble.h/2;
    for(const other of bubbles) {
      if(other===bubble) continue;
      const overlap=Math.min(bubble.x+bubble.w,other.x+other.w)-Math.max(bubble.x,other.x);
      if(overlap>Math.min(bubble.w,other.w)*.18) {
        if(other.y>bubble.y&&y>=other.y-other.h*.12) return false;
        if(other.y<bubble.y&&y>=bubble.y-bubble.h*.12) continue;
      }
      if(x<other.x-other.w*.12||x>other.x+other.w*1.12||y<other.y-other.h*.12||y>other.y+other.h*1.12) continue;
      if(other.y>bubble.y && y>=other.y-other.h*.12) return false;
      const ox=other.x+other.w/2, oy=other.y+other.h/2;
      if((x-ox)**2+(y-oy)**2 < (x-cx)**2+(y-cy)**2) return false;
    }
    return true;
  }

  function hasStackedPartner(bubble) {
    return bubbles.some(other=>other!==bubble&&
      Math.min(bubble.x+bubble.w,other.x+other.w)-Math.max(bubble.x,other.x)>Math.min(bubble.w,other.w)*.18&&
      Math.abs(bubble.y+bubble.h/2-other.y-other.h/2)<(bubble.h+other.h)*1.1);
  }

  function linesFor(text,ctx,width) {
    const lines=[];
    for(const paragraph of text.split('\n')) {
      if(!paragraph.trim()) { lines.push(''); continue; }
      let line='';
      for(const word of paragraph.trim().split(/\s+/)) {
        const candidate=line?`${line} ${word}`:word;
        if(ctx.measureText(candidate).width<=width) { line=candidate; continue; }
        if(line) { lines.push(line); line=''; }
        for(const character of Array.from(word)) {
          if(line&&ctx.measureText(line+character).width>width) { lines.push(line); line=''; }
          line+=character;
        }
      }
      lines.push(line);
    }
    return lines;
  }

  function shapedText(text,ctx,bubble,minimumSize) {
    if(bubble.textMode==='manual'||text.includes('\n')) return null;
    const mask=detectedWhiteout(bubble);
    if(!mask) return null;
    const hint=mask.relocated?mask.region:bubble;
    const words=text.split(/\s+/), maxSize=Math.min(48,Math.floor(hint.h*.45),Math.floor(hint.w*.3),Number(bubble.fontSize)||40);
    const allowed=(x,y)=>x>=mask.x&&y>=mask.y&&x<mask.x+mask.w&&y<mask.y+mask.h&&mask.pixels[((y-mask.y)*mask.w+x-mask.x)*4+3]===255&&ownsPixel(bubble,x,y);
    for(let size=maxSize;size>minimumSize;size--) {
      ctx.font=`${bubble.bold?'bold ':''}${size}px "${bubble.font}"`;
      for(const centerY of [.35,.5,.2,.65].map(fraction=>hint.y+hint.h*fraction))
        for(const centerX of [.5,.4,.6].map(fraction=>Math.round(hint.x+hint.w*fraction)))
          for(let count=1;count<=Math.min(words.length,12);count++) {
            const lineHeight=size*1.15, positions=[], widths=[];
            for(let row=0;row<count;row++) {
              const y=centerY+(row-(count-1)/2)*lineHeight;
              let half=0;
              for(let distance=0;distance<Math.min(mask.w,hint.w);distance++) {
                const left=centerX-distance, right=centerX+distance;
                if(![y-size*.58,y,y+size*.58].every(sampleY=>allowed(left,Math.round(sampleY))&&allowed(right,Math.round(sampleY)))) break;
                half=distance;
              }
              positions.push(y);widths.push(Math.max(0,half*2-6));
            }
            if(widths.some(width=>width<size*1.2)) continue;
            const lines=[];let at=0;
            for(let row=0;row<count&&at<words.length;row++) {
              let line='';
              while(at<words.length) {
                const next=line?`${line} ${words[at]}`:words[at];
                if(ctx.measureText(next).width>widths[row]) break;
                line=next;at++;
              }
              if(!line) break;
              lines.push(line);
            }
            if(at===words.length&&lines.length===count) return {size,lines,positions,centerX,area:{x:centerX-Math.max(...widths)/2,y:positions[0]-size*.6,w:Math.max(...widths),h:positions[count-1]-positions[0]+size*1.2}};
          }
    }
    return null;
  }

  function paintText(ctx,bubble) {
    const {x,y,w,h}=textBox(bubble), text=bubble.translation.trim();
    if(!text) { bubble.overflow=false; bubble.effectiveBox=null; return; }
    const pad=Math.min(bubble.padding,w/5,h/5), maxWidth=w-2*pad, maxHeight=h-2*pad;
    if(maxWidth<5||maxHeight<5) { bubble.overflow=true; return; }
    let size=Math.min(160,Math.max(6,Number(bubble.fontSize)||40)), lines=[];
    for(;size>=6;size--) {
      ctx.font=`${bubble.bold?'bold ':''}${size}px "${bubble.font}"`;
      lines=linesFor(text,ctx,maxWidth);
      if(lines.every(line=>ctx.measureText(line).width<=maxWidth)&&lines.length*size*1.15<=maxHeight) break;
    }
    bubble.overflow=size<6;
    if(size<6) { size=6; ctx.font=`${bubble.bold?'bold ':''}6px "${bubble.font}"`; lines=linesFor(text,ctx,maxWidth); }
    const shaped=(w<bubble.w*.85||h<bubble.h*.68||detectedWhiteout(bubble)?.relocated)?shapedText(text,ctx,bubble,size):null;
    if(shaped) {bubble.overflow=false;ctx.font=`${bubble.bold?'bold ':''}${shaped.size}px "${bubble.font}"`;}
    bubble.effectiveBox=shaped?.area||{x,y,w,h};
    ctx.save(); ctx.beginPath(); ctx.rect(x+pad,y+pad,maxWidth,maxHeight); ctx.clip();
    if(shaped) {ctx.restore();ctx.save();}
    ctx.fillStyle=bubble.color; ctx.textAlign='center'; ctx.textBaseline='middle';
    const lineHeight=size*1.15, start=y+h/2-(lines.length-1)*lineHeight/2;
    if(shaped) shaped.lines.forEach((line,index)=>ctx.fillText(line,shaped.centerX,shaped.positions[index]));
    else lines.forEach((line,index)=>ctx.fillText(line,x+w/2,start+index*lineHeight));
    ctx.restore();
  }

  function render() {
    if (!image) return;
    page.clearRect(0,0,image.naturalWidth,image.naturalHeight);
    page.drawImage(image,0,0);
    bubbles.forEach(bubble => eraseOriginal(page,bubble));
    if(!ui.previewWhiteout.checked) bubbles.forEach(bubble => {
      const mask=bubble.textMode==='manual'?null:detectedWhiteout(bubble);
      if(!mask) { paintText(page,bubble); return; }
      const lettering=document.createElement('canvas'); lettering.width=mask.w; lettering.height=mask.h;
      const context=lettering.getContext('2d'); context.translate(-mask.x,-mask.y); paintText(context,bubble);
      context.setTransform(1,0,0,1,0,0); context.globalCompositeOperation='destination-in'; context.drawImage(mask.canvas,0,0);
      page.drawImage(lettering,mask.x,mask.y);
    });
    ui.textFitStatus.textContent=ui.previewWhiteout.checked?'Previewing whiteout without translated text.':current()?.overflow?'Text does not fit this blue area. Enlarge it or shorten the translation.':'';
    overlay.clearRect(0,0,image.naturalWidth,image.naturalHeight);
    bubbles.forEach((bubble,index) => {
      const box=bubble.effectiveBox||textBox(bubble);
      if(index===selected && bubble.eraseMode==='manual') {
        const e=bubble.erase; overlay.strokeStyle='#e07b28'; overlay.lineWidth=Math.max(2,2/zoom);
        overlay.setLineDash([10,5]); overlay.beginPath();
        if(e.shape==='ellipse') overlay.ellipse(e.x+e.w/2,e.y+e.h/2,e.w/2,e.h/2,0,0,Math.PI*2);
        else overlay.rect(e.x,e.y,e.w,e.h);
        overlay.stroke(); overlay.setLineDash([]);
        if(editingErase) { overlay.fillStyle='#e07b28'; overlay.fillRect(e.x+e.w-9,e.y+e.h-9,18,18); }
      }
      overlay.strokeStyle=index===selected?'#1885df':'#e29b36'; overlay.lineWidth=Math.max(2,2/zoom);
      overlay.setLineDash(index===selected?[]:[8,5]); overlay.strokeRect(box.x,box.y,box.w,box.h); overlay.setLineDash([]);
      overlay.fillStyle = index === selected ? '#1885df' : '#e29b36'; overlay.fillRect(box.x,box.y,25,22);
      overlay.fillStyle = '#fff'; overlay.font = 'bold 14px Arial'; overlay.textAlign = 'center'; overlay.textBaseline = 'middle'; overlay.fillText(String(index+1),box.x+12,box.y+11);
      if (index === selected && !editingErase) overlay.fillRect(box.x+box.w-9,box.y+box.h-9,18,18);
      if(index===selected&&bubble.overflow&&!ui.previewWhiteout.checked) { overlay.fillStyle='#b12626'; overlay.fillRect(box.x+box.w-28,box.y,28,22); overlay.fillStyle='#fff'; overlay.fillText('!',box.x+box.w-14,box.y+11); }
    });
    if (action?.kind === 'draw' && action.preview.w > 0 && action.preview.h > 0) {
      const {x,y,w,h} = action.preview;
      overlay.strokeStyle = '#1885df'; overlay.lineWidth = 3 / zoom; overlay.setLineDash([8,5]); overlay.beginPath(); overlay.ellipse(x+w/2,y+h/2,w/2,h/2,0,0,Math.PI*2); overlay.stroke(); overlay.setLineDash([]);
    }
  }

  function updateUi() {
    ui.bubbleCount.textContent = bubbles.length;
    ui.bubbleList.replaceChildren();
    if (!bubbles.length) { const p = document.createElement('p'); p.className = 'hint'; p.textContent = 'No bubbles yet.'; ui.bubbleList.append(p); }
    bubbles.forEach((bubble,index) => {
      const button = document.createElement('button'); button.className = `bubble-item ${index === selected ? 'active' : ''}`;
      const number = document.createElement('b'); number.textContent = `#${index+1}`;
      const title = document.createElement('span'); title.textContent = (bubble.translation || bubble.source || 'Untitled bubble') + (bubble.uncertain ? ' · review' : '');
      button.append(number,title); button.addEventListener('click',() => select(index)); ui.bubbleList.append(button);
    });
    const bubble = current(); ui.bubbleForm.hidden = !bubble; ui.deleteRegion.disabled = !bubble;
    if (bubble) {
      ui.eraseMode.value=bubble.eraseMode; ui.textMode.value=bubble.textMode; ui.regionShape.value=bubble.erase.shape; ui.regionShape.disabled=bubble.eraseMode!=='manual';
      ui.editErase.textContent=editingErase?'Done editing whiteout':'Edit whiteout area';
      ui.whiteoutBrush.textContent=brushing?'Done brushing':'Brush remaining letters'; ui.undoBrush.disabled=!bubble.eraseStrokes.length;
      ui.sourceText.value = bubble.source; ui.translatedText.value = bubble.translation; ui.fillMode.value=bubble.fillMode; ui.fillColor.value = bubble.fill; ui.fillColor.disabled=bubble.fillMode==='auto';
      ui.textColor.value = bubble.color; ui.fontSize.value = bubble.fontSize; ui.padding.value = bubble.padding;
      ui.fontFamily.value = bubble.font; ui.boldText.checked = bubble.bold; ui.uncertain.checked = Boolean(bubble.uncertain);
    }
  }

  function select(index) { if(selected!==index) { editingErase=false; brushing=false; } selected = index; updateUi(); render(); }
  function point(event) { const rect = ui.overlayCanvas.getBoundingClientRect(); return {x: clamp((event.clientX - rect.left) * image.naturalWidth / rect.width,0,image.naturalWidth), y: clamp((event.clientY - rect.top) * image.naturalHeight / rect.height,0,image.naturalHeight)}; }
  function hit(p) {
    for (let i=bubbles.length-1;i>=0;i--) {
      const b=bubbles[i], area=editingErase&&i===selected?b.erase:(b.effectiveBox||textBox(b));
      if (p.x >= area.x && p.x <= area.x+area.w && p.y >= area.y && p.y <= area.y+area.h) return {index:i,kind:(i===selected && p.x>area.x+area.w-20 && p.y>area.y+area.h-20) ? 'resize' : 'move'};
    }
    return null;
  }

  ui.overlayCanvas.addEventListener('pointerdown', event => {
    if (!image) return;
    if(brushing&&current()) {
      const stroke={size:clamp(Number(ui.brushSize.value)||16,2,80),points:[point(event)]};
      current().eraseStrokes.push(stroke); action={kind:'brush',stroke};
      ui.overlayCanvas.setPointerCapture(event.pointerId); updateUi(); render(); return;
    }
    const p=point(event); const found=hit(p);
    if (action?.kind === 'armed') { action={kind:'draw',start:p,preview:{x:p.x,y:p.y,w:0,h:0}}; }
    else if (found) { select(found.index); if(!editingErase&&current().textMode!=='manual') { const box=current().effectiveBox||textBox(current()); Object.assign(current(),box); current().textMode='manual'; updateUi(); } action={kind:found.kind,start:p,original:{...(editingErase?current().erase:current())},erase:editingErase}; }
    else { select(-1); return; }
    ui.overlayCanvas.setPointerCapture(event.pointerId); render();
  });
  ui.overlayCanvas.addEventListener('pointermove', event => {
    if (!action || action.kind === 'armed' || !image) return;
    if(action.kind==='brush') { action.stroke.points.push(point(event)); render(); return; }
    const p=point(event), dx=p.x-action.start.x, dy=p.y-action.start.y;
    if (action.kind === 'draw') action.preview={x:Math.min(p.x,action.start.x),y:Math.min(p.y,action.start.y),w:Math.abs(dx),h:Math.abs(dy)};
    const b=action.erase?current().erase:current();
    if (action.kind === 'move') { b.x=clamp(action.original.x+dx,0,image.naturalWidth-b.w); b.y=clamp(action.original.y+dy,0,image.naturalHeight-b.h); }
    if (action.kind === 'resize') { b.w=clamp(action.original.w+dx,20,image.naturalWidth-b.x); b.h=clamp(action.original.h+dy,20,image.naturalHeight-b.y); }
    render();
  });
  ui.overlayCanvas.addEventListener('pointerup', event => {
    if (!action || action.kind === 'armed') return;
    if(action.kind==='brush') { action=null; ui.overlayCanvas.releasePointerCapture(event.pointerId); updateUi(); render(); return; }
    if (action.kind === 'draw' && action.preview.w >= 20 && action.preview.h >= 20) {
      const b={id:nextId++,layoutVersion:2,typographyVersion:1,letteringVersion:1,...action.preview,erase:{...action.preview,shape:'ellipse'},eraseMode:'auto',fillMode:'auto',textMode:'manual',eraseStrokes:[],source:'',translation:'',fill:'#ffffff',color:'#111111',fontSize:60,padding:5,font:'Comic Sans MS',bold:true,uncertain:false};
      bubbles.push(b); selected=bubbles.length-1; setStatus('Bubble added. Enter its translation below.');
    }
    action=null; ui.overlayCanvas.releasePointerCapture(event.pointerId); updateUi(); render();
  });
  ui.addRegion.addEventListener('click',() => { brushing=false; editingErase=false; action={kind:'armed'}; updateUi(); setStatus('Drag inside a speech bubble to mark its editable area.'); });
  ui.deleteRegion.addEventListener('click',() => { if (!current()) return; bubbles.splice(selected,1); selected=Math.min(selected,bubbles.length-1); updateUi(); render(); });
  ui.eraseMode.addEventListener('change',()=>{ const b=current(); if(!b) return; b.eraseMode=ui.eraseMode.value; if(b.eraseMode==='auto') editingErase=false; updateUi(); render(); });
  ui.fillMode.addEventListener('change',()=>{ const b=current(); if(!b) return; b.fillMode=ui.fillMode.value; updateUi(); render(); });
  ui.textMode.addEventListener('change',()=>{ const b=current(); if(!b) return; if(ui.textMode.value==='manual'&&b.textMode!=='manual') Object.assign(b,textBox(b)); b.textMode=ui.textMode.value; updateUi(); render(); });
  ui.regionShape.addEventListener('change',()=>{ const b=current(); if(!b) return; b.erase.shape=ui.regionShape.value; render(); });
  ui.editErase.addEventListener('click',()=>{ const b=current(); if(!b) return; if(!editingErase) b.eraseMode='manual'; brushing=false; editingErase=!editingErase; updateUi(); render(); setStatus(editingErase?'Drag the orange outline to cover all original lettering without crossing the bubble border.':'Whiteout area set. Adjust the blue text area next.'); });
  ui.whiteoutBrush.addEventListener('click',()=>{ if(!current()) return; brushing=!brushing; editingErase=false; updateUi(); render(); setStatus(brushing?'Paint over remaining original letters. Keep the brush inside the bubble; use Undo if needed.':'Whiteout brush finished.'); });
  ui.undoBrush.addEventListener('click',()=>{ const b=current(); if(!b) return; b.eraseStrokes.pop(); updateUi(); render(); });
  for (const [id,key,convert] of [['sourceText','source',String],['translatedText','translation',String],['fillColor','fill',String],['textColor','color',String],['fontSize','fontSize',Number],['padding','padding',Number],['fontFamily','font',String],['boldText','bold',Boolean],['uncertain','uncertain',Boolean]]) {
    ui[id].addEventListener('input',() => { const b=current(); if (!b) return; b[key]=convert(id==='boldText' || id==='uncertain' ? ui[id].checked : ui[id].value); if (id==='translatedText' || id==='sourceText' || id==='uncertain') updateListTitle(); render(); });
  }
  function updateListTitle() { const b=current(), title=ui.bubbleList.children[selected]?.querySelector('span'); if (b && title) title.textContent=(b.translation || b.source || 'Untitled bubble') + (b.uncertain ? ' · review' : ''); }
  ui.imageFile.addEventListener('change',async () => {
    const file=ui.imageFile.files?.[0]; if (!file) return;
    if (!['image/png','image/jpeg','image/webp'].includes(file.type) || file.size > 20*1024*1024) { setStatus('Choose a PNG, JPG, or WebP under 20 MB.'); return; }
    const reader=new FileReader(); reader.onload=async () => { try { await setImage(reader.result,file.name); setStatus('Click Add bubble, then drag inside a bubble.'); } catch (e) { setStatus(e.message); } }; reader.readAsDataURL(file);
  });
  function download(blob,name) { const url=URL.createObjectURL(blob), a=document.createElement('a'); a.href=url; a.download=name; a.click(); setTimeout(() => URL.revokeObjectURL(url),1000); }
  ui.exportPng.addEventListener('click',() => ui.pageCanvas.toBlob(blob => { if (blob) download(blob,`${fileName.replace(/\.[^.]+$/,'')}-translated.png`); },'image/png'));
  ui.saveProject.addEventListener('click',() => { const data={version:1,fileName,image:imageData,bubbles}; download(new Blob([JSON.stringify(data)],{type:'application/json'}),`${fileName.replace(/\.[^.]+$/,'')}-flostate.json`); });
  function restoreBubbles(raw) {
    bubbles=raw.filter(b=>Number.isFinite(b.x)&&Number.isFinite(b.y)&&Number.isFinite(b.w)&&Number.isFinite(b.h)&&b.w>0&&b.h>0&&b.x>=0&&b.y>=0&&b.x+b.w<=image.naturalWidth&&b.y+b.h<=image.naturalHeight).map(b=>{
      const old=b.layoutVersion!==2, erase=b.erase&&Number.isFinite(b.erase.x)&&Number.isFinite(b.erase.y)&&Number.isFinite(b.erase.w)&&Number.isFinite(b.erase.h)&&b.erase.w>0&&b.erase.h>0?b.erase:{x:b.x,y:b.y,w:b.w,h:b.h,shape:b.shape};
      const eraseStrokes=Array.isArray(b.eraseStrokes)?b.eraseStrokes.slice(0,100).map(stroke=>({size:clamp(Number(stroke.size)||16,2,80),points:Array.isArray(stroke.points)?stroke.points.slice(0,1000).filter(point=>Number.isFinite(point.x)&&Number.isFinite(point.y)&&point.x>=0&&point.y>=0&&point.x<=image.naturalWidth&&point.y<=image.naturalHeight).map(point=>({x:point.x,y:point.y})):[]})):[];
      const upgradeTypography=b.textMode!=='manual'&&!b.typographyVersion;
      return {id:Number(b.id)||nextId++,layoutVersion:2,typographyVersion:1,letteringVersion:1,x:b.x,y:b.y,w:b.w,h:b.h,erase:{x:clamp(erase.x,0,image.naturalWidth),y:clamp(erase.y,0,image.naturalHeight),w:clamp(erase.w,1,image.naturalWidth-erase.x),h:clamp(erase.h,1,image.naturalHeight-erase.y),shape:erase.shape==='rectangle'?'rectangle':'ellipse'},eraseMode:b.eraseMode==='manual'?'manual':'auto',fillMode:b.fillMode==='manual'?'manual':'auto',textMode:b.textMode==='manual'?'manual':'auto',eraseStrokes,source:String(b.source||''),translation:String(b.translation||''),fill:/^#[0-9a-f]{6}$/i.test(b.fill)?b.fill:'#ffffff',color:/^#[0-9a-f]{6}$/i.test(b.color)?b.color:'#111111',fontSize:upgradeTypography?160:old?60:clamp(Number(b.fontSize)||60,6,160),padding:upgradeTypography?3:old?5:clamp(Number(b.padding)||0,0,100),font:['Arial','Georgia','Verdana','Comic Sans MS'].includes(b.font)?b.font:'Comic Sans MS',bold:Boolean(b.bold),uncertain:Boolean(b.uncertain)};
    });
    nextId=Math.max(1,...bubbles.map(b=>b.id+1)); selected=bubbles.length?0:-1; updateUi(); render();
  }
  ui.openProject.addEventListener('change',async () => {
    const file=ui.openProject.files?.[0]; if (!file) return;
    try {
      const data=JSON.parse(await file.text());
      if (data.version!==1 || typeof data.image!=='string' || !/^data:image\/(png|jpeg|webp);base64,/.test(data.image) || !Array.isArray(data.bubbles)) throw Error('Invalid project file.');
      await setImage(data.image,data.fileName);
      restoreBubbles(data.bubbles); setStatus('Project opened.');
    } catch(e) { setStatus(`Could not open project: ${e.message}`); }
    ui.openProject.value='';
  });
  ui.zoomOut.addEventListener('click',() => { zoom=clamp(zoom/1.25,.1,3); updateZoom(); });
  ui.zoomIn.addEventListener('click',() => { zoom=clamp(zoom*1.25,.1,3); updateZoom(); });
  ui.previewWhiteout.addEventListener('change',()=>{ ui.exportPng.disabled=ui.previewWhiteout.checked; render(); });
  if (serverConfig) {
    ui.analyzePage.hidden = false; ui.analyzePage.disabled = !serverConfig.aiConfigured;
    ui.analyzePage.title = serverConfig.aiConfigured ? `Analyze with ${serverConfig.aiModel}` : 'Configure an OpenAI key on the server first';
    ui.savePage.hidden = false;
    ui.imageFile.disabled = true; ui.imageFile.hidden = true; ui.imageFile.previousElementSibling.hidden = true;
    ui.openProject.disabled = true; ui.openProject.parentElement.hidden = true;
    ui.analyzePage.addEventListener('click',async () => {
      if (bubbles.length && !window.confirm('Replace the current unsaved bubble suggestions with a new AI analysis? Saved edits can be restored by reloading this page.')) return;
      ui.analyzePage.disabled = true; setStatus(`Analyzing with ${serverConfig.aiModel}. This may take a minute…`);
      try {
        const token=document.querySelector('input[name="__RequestVerificationToken"]').value;
        const response=await fetch(serverConfig.analyzeUrl,{method:'POST',headers:{'RequestVerificationToken':token}});
        const data=await response.json();
        if (!response.ok) throw Error(data.error || `Server returned ${response.status}`);
        if (!Array.isArray(data.bubbles)) throw Error('The AI result contained no bubble list.');
        const candidates=data.bubbles.map((b,index) => ({id:index+1,x:b.x/1000*image.naturalWidth,y:b.y/1000*image.naturalHeight,w:b.w/1000*image.naturalWidth,h:b.h/1000*image.naturalHeight,shape:b.shape,source:b.source,translation:b.translation,uncertain:b.uncertain,fill:'#ffffff',color:'#111111',fontSize:160,padding:3,font:b.font||'Comic Sans MS',bold:b.bold!==false}));
        restoreBubbles(candidates);
        setStatus(`${bubbles.length} bubble suggestions ready. Review text and positions, then save the page.`);
      } catch(e) { setStatus(`AI analysis failed: ${e.message}`); }
      finally { ui.analyzePage.disabled = false; }
    });
    ui.savePage.addEventListener('click',async () => {
      try {
        const token=document.querySelector('input[name="__RequestVerificationToken"]').value;
        const response=await fetch(serverConfig.saveUrl,{method:'POST',headers:{'Content-Type':'application/json','RequestVerificationToken':token},body:JSON.stringify({version:1,bubbles})});
        if (!response.ok) throw Error(`Server returned ${response.status}`);
        setStatus('Page edits saved to this comic.');
      } catch(e) { setStatus(`Save failed: ${e.message}`); }
    });
    (async () => {
      try {
        const response=await fetch(serverConfig.imageUrl);
        if (!response.ok) throw Error('Page image could not be loaded.');
        const blob=await response.blob();
        const reader=new FileReader();
        reader.onload=async () => {
          try {
            await setImage(reader.result, serverConfig.fileName);
            if (serverConfig.draft) {
              const draft = JSON.parse(serverConfig.draft);
              if (draft.version === 1 && Array.isArray(draft.bubbles)) {
                restoreBubbles(draft.bubbles);
              }
            }
            setStatus('Page loaded. Add or edit bubbles, then save the page.');
            if (window.parent !== window && new URLSearchParams(location.search).has('readerSnapshot')) {
              window.parent.postMessage({type:'flostate-reader-ready'}, location.origin);
            }
          }
          catch(e) { setStatus(e.message); }
        };
        reader.readAsDataURL(blob);
      } catch(e) { setStatus(e.message); }
    })();
  }
})();
