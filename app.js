(function(){
'use strict';

/* ---------- tiny helpers ---------- */
function h(tag, attrs){
  var e = document.createElement(tag);
  if(attrs){
    Object.keys(attrs).forEach(function(k){
      var v = attrs[k];
      if(v == null || v === false) return;
      if(k === 'class') e.className = v;
      else if(k.indexOf('on') === 0) e.addEventListener(k.slice(2), v);
      else if(v === true) e.setAttribute(k, '');
      else e.setAttribute(k, v);
    });
  }
  var kids = Array.prototype.slice.call(arguments, 2);
  (function add(list){
    list.forEach(function(c){
      if(c == null || c === false) return;
      if(Array.isArray(c)) return add(c);
      e.append(c.nodeType ? c : document.createTextNode(String(c)));
    });
  })(kids);
  return e;
}
var SVGS = {
  up:'<path d="M12 19V5M5 12l7-7 7 7"/>',
  down:'<path d="M12 5v14M19 12l-7 7-7-7"/>',
  x:'<path d="M6 6l12 12M18 6L6 18"/>',
  chev:'<path d="M9 6l6 6-6 6"/>',
  back:'<path d="M15 6l-6 6 6 6"/>'
};
function icon(n, size){
  var s = document.createElement('span'); s.className = 'ic';
  s.innerHTML = '<svg viewBox="0 0 24 24" width="'+(size||20)+'" height="'+(size||20)+'" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+SVGS[n]+'</svg>';
  return s;
}
function fmt(b){ return b < 1024 ? b+' B' : b < 1048576 ? Math.round(b/1024)+' KB' : (b/1048576).toFixed(1)+' MB'; }
function baseName(n){ return (n.replace(/\.[^.]+$/,'').replace(/[^\w\-. ]+/g,'_').trim().slice(0,60)) || 'file'; }
function pad(n,total){ return String(n).padStart(String(total).length,'0'); }
function tick(){ return new Promise(function(r){ setTimeout(r,0); }); }
function pdfBlob(bytes){ return new Blob([bytes],{type:'application/pdf'}); }
function toBlob(canvas,type,q){ return new Promise(function(res,rej){ canvas.toBlob(function(b){ b ? res(b) : rej(new Error('Could not create the image.')); },type,q); }); }

/* ---------- libraries ---------- */
function needPdfLib(){
  if(!window.PDFLib) throw new Error('The PDF engine did not load. Check your internet connection and reload the page.');
  return window.PDFLib;
}
function needPdfJs(){
  var p = window.pdfjsLib || window['pdfjs-dist/build/pdf'];
  if(!p) throw new Error('The PDF viewer engine did not load. Check your internet connection and reload the page.');
  if(!p.GlobalWorkerOptions.workerSrc) p.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  return p;
}
function zipFiles(files){
  if(!window.JSZip) throw new Error('The zip engine did not load. Check your internet connection and reload the page.');
  var z = new window.JSZip();
  files.forEach(function(f){ z.file(f.name, f.blob); });
  return z.generateAsync({type:'blob', compression:'STORE'});
}
async function loadPdf(file){
  var lib = needPdfLib();
  try{
    return await lib.PDFDocument.load(await file.arrayBuffer(), {ignoreEncryption:true, updateMetadata:false});
  }catch(e){
    throw new Error('Could not read ' + file.name + '. It may be damaged or password-protected.');
  }
}

/* ---------- saving files ---------- */
var dlCap;
async function getDl(){
  if(dlCap !== undefined) return dlCap;
  if(window.claude && typeof window.claude.use === 'function'){
    try{ dlCap = await window.claude.use('downloads'); }catch(e){ dlCap = null; }
  } else {
    dlCap = 'anchor';
  }
  return dlCap;
}
async function saveFile(name, blob){
  var d = await getDl();
  if(d === 'anchor'){
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function(){ URL.revokeObjectURL(a.href); }, 5000);
    return {status:'saved'};
  }
  if(!d) throw {code:'unavailable'};
  return d.save({filename:name, data:blob});
}
getDl();

/* ---------- page ranges ---------- */
function parseRanges(input, total){
  var s = (input||'').trim().toLowerCase().replace(/\s*-\s*/g,'-');
  if(!s || s === 'all') return Array.from({length:total}, function(_,i){ return i; });
  var set = new Set();
  s.split(/[\s,]+/).filter(Boolean).forEach(function(part){
    var m = part.match(/^(\d+)(-(\d*))?$/);
    if(!m) throw new Error('"'+part+'" is not a valid page number or range. Use something like 1-3, 5, 8-10.');
    var a = parseInt(m[1],10);
    var b = m[2] === undefined ? a : (m[3] === '' ? total : parseInt(m[3],10));
    if(a < 1 || a > total || b > total) throw new Error('"'+part+'" is outside this PDF, which has '+total+' page'+(total===1?'':'s')+'.');
    if(b < a) throw new Error('"'+part+'" goes backwards. Write the smaller page number first.');
    for(var i=a;i<=b;i++) set.add(i-1);
  });
  return Array.from(set).sort(function(x,y){ return x-y; });
}

/* ---------- page geometry (handles rotated pages) ---------- */
function rotOf(p){ return ((p.getRotation().angle % 360) + 360) % 360; }
function visibleSize(p){
  var b = p.getCropBox(), r = rotOf(p);
  return (r === 90 || r === 270) ? {W:b.height, H:b.width} : {W:b.width, H:b.height};
}
function toUser(p, vx, vy){
  var mb = p.getCropBox(), w = mb.width, hh = mb.height, r = rotOf(p), x, y;
  if(r === 0){ x = vx; y = vy; }
  else if(r === 90){ x = w - vy; y = vx; }
  else if(r === 180){ x = w - vx; y = hh - vy; }
  else { x = vy; y = hh - vx; }
  return {x:x+mb.x, y:y+mb.y, rot:r};
}

/* ---------- rendering with pdf.js ---------- */
async function renderJpeg(page, scale, q){
  var vp = page.getViewport({scale:scale});
  var MAX = 12e6;
  if(vp.width*vp.height > MAX){ scale *= Math.sqrt(MAX/(vp.width*vp.height)); vp = page.getViewport({scale:scale}); }
  var c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(vp.width)); c.height = Math.max(1, Math.ceil(vp.height));
  var cx = c.getContext('2d', {alpha:false});
  cx.fillStyle = '#fff'; cx.fillRect(0,0,c.width,c.height);
  await page.render({canvasContext:cx, viewport:vp}).promise;
  var blob = await toBlob(c, 'image/jpeg', q);
  c.width = c.height = 0;
  return blob;
}
function sniffFormat(u8, name){
  function ascii(a, b){ var t = ''; for(var i=a; i<b && i<u8.length; i++) t += String.fromCharCode(u8[i]); return t; }
  if(u8[0] === 0xFF && u8[1] === 0xD8) return {name:'JPEG', mime:'image/jpeg'};
  if(u8[0] === 0x89 && ascii(1,4) === 'PNG') return {name:'PNG', mime:'image/png'};
  if(ascii(0,4) === 'GIF8') return {name:'GIF', mime:'image/gif'};
  if(ascii(0,4) === 'RIFF' && ascii(8,12) === 'WEBP') return {name:'WebP', mime:'image/webp'};
  if(ascii(0,2) === 'BM') return {name:'BMP', mime:'image/bmp'};
  if(ascii(0,4) === 'II*\u0000' || ascii(0,4) === 'MM\u0000*') return {name:'TIFF', mime:'image/tiff'};
  if(ascii(4,8) === 'ftyp'){
    var brand = ascii(8,12);
    if(brand === 'avif' || brand === 'avis') return {name:'AVIF', mime:'image/avif'};
    if(/^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(brand)) return {name:'HEIC', mime:'image/heic'};
  }
  var head = ascii(0,300).toLowerCase();
  if(head.indexOf('<svg') > -1) return {name:'SVG', mime:'image/svg+xml'};
  var ext = (name.match(/\.([a-z0-9]+)$/i) || [])[1];
  ext = ext ? ext.toLowerCase() : '';
  var byExt = {jpg:['JPEG','image/jpeg'], jpeg:['JPEG','image/jpeg'], jfif:['JPEG','image/jpeg'], png:['PNG','image/png'], gif:['GIF','image/gif'], webp:['WebP','image/webp'], bmp:['BMP','image/bmp'], avif:['AVIF','image/avif'], heic:['HEIC','image/heic'], heif:['HEIC','image/heic'], svg:['SVG','image/svg+xml'], tif:['TIFF','image/tiff'], tiff:['TIFF','image/tiff']};
  if(byExt[ext]) return {name:byExt[ext][0], mime:byExt[ext][1]};
  return {name:'Image', mime:''};
}
function loadScript(src){
  return new Promise(function(res, rej){
    var el = document.createElement('script');
    el.src = src; el.onload = res;
    el.onerror = function(){ rej(new Error('Could not load the HEIC converter. Check your internet connection.')); };
    document.head.appendChild(el);
  });
}
async function heicToJpeg(blob){
  if(!window.heic2any) await loadScript('https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js');
  var out = await window.heic2any({blob:blob, toType:'image/jpeg', quality:0.92});
  return Array.isArray(out) ? out[0] : out;
}
function imgFromUrl(url){
  return new Promise(function(res, rej){
    var im = new Image();
    im.onload = function(){ res(im); };
    im.onerror = function(){ rej(new Error('img failed')); };
    im.src = url;
  });
}
async function viaImg(blob){
  var u = URL.createObjectURL(blob);
  try{
    var im = await imgFromUrl(u);
    return {src:im, w:im.naturalWidth || 1200, h:im.naturalHeight || 1200, done:function(){ URL.revokeObjectURL(u); }};
  }catch(e){ URL.revokeObjectURL(u); throw e; }
}
function viaData(blob){
  return new Promise(function(res, rej){
    var fr = new FileReader();
    fr.onerror = function(){ rej(new Error('read failed')); };
    fr.onload = async function(){
      try{ var im = await imgFromUrl(fr.result); res({src:im, w:im.naturalWidth || 1200, h:im.naturalHeight || 1200, done:function(){}}); }
      catch(e){ rej(e); }
    };
    fr.readAsDataURL(blob);
  });
}
async function decodeImage(f){
  var blob = f.blob;
  if(f.fmtName === 'HEIC'){
    try{ blob = await heicToJpeg(blob); }catch(e){ console.error(e); }
  }
  try{ return await viaImg(blob); }catch(e){}
  try{
    var bmp = await createImageBitmap(blob);
    return {src:bmp, w:bmp.width, h:bmp.height, done:function(){ try{ bmp.close(); }catch(e){} }};
  }catch(e){}
  try{ return await viaData(blob); }catch(e){}
  if(f.fmtName === 'HEIC') throw new Error('Could not convert '+f.name+' (HEIC). Set your camera to save JPG, or share the photo as JPG, then try again.');
  throw new Error('Could not open '+f.name+' ('+(f.fmtName || 'unknown format')+'). Remove it and pick it again from your gallery.');
}

/* ---------- option builders ---------- */
function field(label, control, hint){
  return h('label',{class:'field'}, h('span',{class:'lbl'},label), control, hint ? h('span',{class:'hint'},hint) : null);
}
function radios(name, legend, choices, initial, onChange){
  return h('fieldset',{class:'group-fs'},
    h('legend',null,legend),
    h('div',{class:'choices'}, choices.map(function(c){
      return h('label',{class:'choice'},
        h('input',{type:'radio',name:name,value:c.v,checked:c.v===initial,onchange:function(){ onChange(c.v); }}),
        h('span',null, h('b',null,c.t), c.d ? h('small',null,c.d) : null));
    })));
}
function textInput(ctx, key, placeholder){
  return h('input',{type:'text',placeholder:placeholder||'',autocomplete:'off',autocapitalize:'off',spellcheck:'false',
    oninput:function(e){ ctx.opts[key] = e.target.value; }});
}

/* ---------- tool definitions ---------- */
var TOOLS = [
  { id:'edit', group:'Edit', name:'Edit PDF', blurb:'Add text, cover mistakes with a white box and highlight parts of your PDF.',
    kind:'pdf', custom:true, drop:'Choose a PDF file' },

  { id:'merge', group:'Organise', name:'Merge PDF', blurb:'Combine several PDFs into one file, in the order you choose.',
    kind:'pdf', multiple:true, reorder:true, min:2, drop:'Choose PDF files', action:'Merge PDFs',
    async run(ctx, ui){
      var lib = needPdfLib(), out = await lib.PDFDocument.create(), n = ctx.files.length, total = 0;
      for(var i=0;i<n;i++){
        var f = ctx.files[i];
        ui.progress(i/n, 'Adding '+f.name); await tick();
        var src = await loadPdf(f.file), idx = src.getPageIndices();
        var pages = await out.copyPages(src, idx);
        pages.forEach(function(p){ out.addPage(p); });
        total += idx.length;
      }
      ui.progress(0.95, 'Saving your file'); await tick();
      var bytes = await out.save();
      return {summary:'Merged '+n+' PDFs into one file with '+total+' pages.', files:[{name:'merged.pdf', blob:pdfBlob(bytes)}]};
    }},

  { id:'split', group:'Organise', name:'Split PDF', blurb:'Keep only the pages you need, or break a PDF into single pages.',
    kind:'pdf', drop:'Choose a PDF file', action:'Split PDF',
    options(ctx){
      ctx.opts.mode = 'extract'; ctx.opts.pages = '';
      var pf = field('Pages to keep', textInput(ctx,'pages','1-3, 5, 8-10'), 'Use commas and dashes. Example: 1-3, 5, 8-10');
      var modes = radios('split-mode','What do you want?',[
        {v:'extract', t:'Keep some pages', d:'Get one PDF with only the pages you pick'},
        {v:'each', t:'Every page separately', d:'Get a zip file with one PDF per page'}
      ],'extract',function(v){ ctx.opts.mode = v; pf.hidden = v !== 'extract'; });
      return h('div',{class:'opts'}, modes, pf);
    },
    async run(ctx, ui){
      var lib = needPdfLib(), f = ctx.files[0], src = await loadPdf(f.file), total = src.getPageCount(), base = baseName(f.name);
      if(ctx.opts.mode === 'each'){
        var files = [];
        for(var i=0;i<total;i++){
          ui.progress(i/total, 'Splitting page '+(i+1)+' of '+total); await tick();
          var d = await lib.PDFDocument.create(), pg = await d.copyPages(src,[i]);
          d.addPage(pg[0]);
          files.push({name:base+'-page-'+pad(i+1,total)+'.pdf', blob:pdfBlob(await d.save())});
        }
        ui.progress(0.97, 'Making the zip file');
        var zip = await zipFiles(files);
        return {summary:'Split into '+total+' single-page PDFs.', files:[{name:base+'-pages.zip', blob:zip}]};
      }
      if(!ctx.opts.pages.trim()) throw new Error('Type the pages you want to keep, for example 1-3, 5.');
      var idx = parseRanges(ctx.opts.pages, total);
      ui.progress(0.5, 'Splitting'); await tick();
      var out = await lib.PDFDocument.create();
      (await out.copyPages(src, idx)).forEach(function(p){ out.addPage(p); });
      return {summary:'Kept '+idx.length+' of '+total+' pages.', files:[{name:base+'-selected.pdf', blob:pdfBlob(await out.save())}]};
    }},

  { id:'remove-pages', group:'Organise', name:'Remove pages', blurb:'Delete the pages you do not want and keep the rest.',
    kind:'pdf', drop:'Choose a PDF file', action:'Remove pages',
    options(ctx){
      ctx.opts.pages = '';
      return h('div',{class:'opts'}, field('Pages to remove', textInput(ctx,'pages','2, 4-6'), 'Use commas and dashes. Example: 2, 4-6'));
    },
    async run(ctx, ui){
      var f = ctx.files[0], doc = await loadPdf(f.file), total = doc.getPageCount();
      if(!ctx.opts.pages.trim()) throw new Error('Type the pages you want to remove, for example 2, 4-6.');
      var rm = parseRanges(ctx.opts.pages, total);
      if(rm.length >= total) throw new Error('That would remove every page. Keep at least one page.');
      ui.progress(0.5, 'Removing pages'); await tick();
      rm.slice().reverse().forEach(function(i){ doc.removePage(i); });
      return {summary:'Removed '+rm.length+' page'+(rm.length===1?'':'s')+'. '+(total-rm.length)+' left.', files:[{name:baseName(f.name)+'-edited.pdf', blob:pdfBlob(await doc.save())}]};
    }},

  { id:'rotate', group:'Organise', name:'Rotate PDF', blurb:'Fix sideways or upside-down pages.',
    kind:'pdf', drop:'Choose a PDF file', action:'Rotate pages',
    options(ctx){
      ctx.opts.angle = '90'; ctx.opts.pages = '';
      return h('div',{class:'opts'},
        radios('rot-angle','Rotate by',[
          {v:'90', t:'90° clockwise'}, {v:'180', t:'180°'}, {v:'270', t:'90° counter-clockwise'}
        ],'90',function(v){ ctx.opts.angle = v; }),
        field('Pages to rotate', textInput(ctx,'pages','All pages'), 'Leave empty to rotate every page. Or type pages like 1-3, 5.'));
    },
    async run(ctx, ui){
      var lib = needPdfLib(), f = ctx.files[0], doc = await loadPdf(f.file), pages = doc.getPages();
      var idx = parseRanges(ctx.opts.pages, pages.length), a = parseInt(ctx.opts.angle,10);
      ui.progress(0.5, 'Rotating'); await tick();
      idx.forEach(function(i){ var p = pages[i]; p.setRotation(lib.degrees((rotOf(p) + a) % 360)); });
      return {summary:'Rotated '+idx.length+' page'+(idx.length===1?'':'s')+'.', files:[{name:baseName(f.name)+'-rotated.pdf', blob:pdfBlob(await doc.save())}]};
    }},

  { id:'image-to-pdf', group:'Convert', name:'Image to PDF', blurb:'Turn photos into one PDF. Works with JPG, PNG, WebP, HEIC, GIF, BMP, AVIF and SVG.',
    kind:'image', multiple:true, reorder:true, min:1, drop:'Choose images', action:'Convert to PDF',
    options(ctx){
      ctx.opts.size = 'a4'; ctx.opts.margin = true;
      return h('div',{class:'opts'},
        radios('img-size','Page size',[
          {v:'a4', t:'A4 page', d:'Each image fits on an A4 page'},
          {v:'fit', t:'Same size as the image', d:'No white space around the picture'}
        ],'a4',function(v){ ctx.opts.size = v; }),
        h('label',{class:'check'}, h('input',{type:'checkbox',checked:true,onchange:function(e){ ctx.opts.margin = e.target.checked; }}), 'Leave a white margin on A4 pages'));
    },
    async run(ctx, ui){
      var lib = needPdfLib(), doc = await lib.PDFDocument.create(), n = ctx.files.length;
      for(var i=0;i<n;i++){
        var f = ctx.files[i];
        ui.progress(i/n, 'Adding image '+(i+1)+' of '+n); await tick();
        var dec = await decodeImage(f);
        var w = dec.w, hh = dec.h, k = Math.min(1, 3000/Math.max(w,hh));
        w = Math.max(1, Math.round(w*k)); hh = Math.max(1, Math.round(hh*k));
        var c = document.createElement('canvas'); c.width = w; c.height = hh;
        var cx = c.getContext('2d');
        var isPng = f.fmtName === 'PNG';
        if(!isPng){ cx.fillStyle = '#fff'; cx.fillRect(0,0,w,hh); }
        cx.drawImage(dec.src,0,0,w,hh);
        if(dec.done) dec.done();
        var bytes = new Uint8Array(await (await toBlob(c, isPng ? 'image/png' : 'image/jpeg', 0.9)).arrayBuffer());
        c.width = c.height = 0;
        var emb = isPng ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
        var page;
        if(ctx.opts.size === 'fit'){
          var pw = w*0.75, ph = hh*0.75, s = Math.min(1, 1000/Math.max(pw,ph));
          pw *= s; ph *= s;
          page = doc.addPage([pw,ph]);
          page.drawImage(emb,{x:0,y:0,width:pw,height:ph});
        } else {
          var land = w > hh, PW = land ? 841.89 : 595.28, PH = land ? 595.28 : 841.89, m = ctx.opts.margin ? 24 : 0;
          var sc = Math.min((PW-2*m)/w, (PH-2*m)/hh), dw = w*sc, dh = hh*sc;
          page = doc.addPage([PW,PH]);
          page.drawImage(emb,{x:(PW-dw)/2, y:(PH-dh)/2, width:dw, height:dh});
        }
      }
      ui.progress(0.95, 'Saving your file'); await tick();
      var pdf = await doc.save();
      return {summary:'Converted '+n+' image'+(n===1?'':'s')+' into a PDF with '+n+' page'+(n===1?'':'s')+'.', files:[{name:'images.pdf', blob:pdfBlob(pdf)}]};
    }},

  { id:'pdf-to-jpg', group:'Convert', name:'PDF to JPG', blurb:'Save each page of a PDF as a JPG picture.',
    kind:'pdf', drop:'Choose a PDF file', action:'Convert to JPG',
    options(ctx){
      ctx.opts.quality = 'standard'; ctx.opts.pages = '';
      return h('div',{class:'opts'},
        radios('jpg-q','Quality',[
          {v:'small', t:'Small files', d:'Good for sharing on WhatsApp'},
          {v:'standard', t:'Standard', d:'Clear on screens'},
          {v:'high', t:'High quality', d:'Sharp enough to print'}
        ],'standard',function(v){ ctx.opts.quality = v; }),
        field('Pages to convert', textInput(ctx,'pages','All pages'), 'Leave empty to convert every page. Or type pages like 1-3, 5.'));
    },
    async run(ctx, ui){
      var pdfjs = needPdfJs(), f = ctx.files[0], base = baseName(f.name);
      var pr = {small:{s:1.2,q:0.75}, standard:{s:2,q:0.85}, high:{s:3,q:0.92}}[ctx.opts.quality];
      var doc = await pdfjs.getDocument({data:new Uint8Array(await f.file.arrayBuffer())}).promise;
      var idx = parseRanges(ctx.opts.pages, doc.numPages), files = [];
      for(var i=0;i<idx.length;i++){
        ui.progress(i/idx.length, 'Converting page '+(idx[i]+1)+' ('+(i+1)+' of '+idx.length+')'); await tick();
        var page = await doc.getPage(idx[i]+1);
        var blob = await renderJpeg(page, pr.s, pr.q);
        page.cleanup();
        files.push({name:base+'-page-'+pad(idx[i]+1, doc.numPages)+'.jpg', blob:blob});
      }
      await doc.destroy();
      if(files.length === 1) return {summary:'Converted 1 page to JPG.', files:files};
      ui.progress(0.97, 'Making the zip file');
      return {summary:'Converted '+files.length+' pages to JPG. They are packed in one zip file.', files:[{name:base+'-images.zip', blob:await zipFiles(files)}]};
    }},

  { id:'pdf-to-text', group:'Convert', name:'PDF to Text', blurb:'Pull out the text from a PDF and save it as a .txt file.',
    kind:'pdf', drop:'Choose a PDF file', action:'Extract text',
    async run(ctx, ui){
      var pdfjs = needPdfJs(), f = ctx.files[0];
      var doc = await pdfjs.getDocument({data:new Uint8Array(await f.file.arrayBuffer())}).promise;
      var parts = [];
      for(var n=1;n<=doc.numPages;n++){
        ui.progress((n-1)/doc.numPages, 'Reading page '+n+' of '+doc.numPages); await tick();
        var page = await doc.getPage(n), tc = await page.getTextContent(), txt = '', lastY = null;
        tc.items.forEach(function(it){
          if(typeof it.str !== 'string') return;
          var y = it.transform ? it.transform[5] : null;
          if(lastY !== null && y !== null && Math.abs(y-lastY) > 3 && txt && !/\n$/.test(txt)) txt += '\n';
          txt += it.str;
          if(it.hasEOL) txt += '\n';
          if(y !== null) lastY = y;
        });
        parts.push(txt.trim());
        page.cleanup();
      }
      var np = doc.numPages; await doc.destroy();
      var all = parts.join('\n\n');
      if(all.replace(/\s/g,'').length < 5){
        return {summary:'No text found in this PDF.', note:'It looks like a scanned PDF, where pages are pictures. This tool can only read text that is already stored in the file.', files:[]};
      }
      var words = all.split(/\s+/).filter(Boolean).length;
      return {summary:'Found about '+words+' words across '+np+' page'+(np===1?'':'s')+'.', files:[{name:baseName(f.name)+'.txt', blob:new Blob([all],{type:'text/plain'})}]};
    }},

  { id:'compress', group:'Improve', name:'Compress PDF', blurb:'Make a PDF smaller so it is easy to email or upload.',
    kind:'pdf', drop:'Choose a PDF file', action:'Compress PDF',
    options(ctx){
      ctx.opts.level = 'balanced';
      return h('div',{class:'opts'},
        radios('cmp-level','How small?',[
          {v:'good', t:'Good quality', d:'Smaller, but pages stay sharp'},
          {v:'balanced', t:'Balanced', d:'Best mix for most files'},
          {v:'small', t:'Smallest file', d:'Lowest quality, for tight upload limits'}
        ],'balanced',function(v){ ctx.opts.level = v; }),
        h('p',{class:'hint'},'Compressing turns pages into pictures, so you cannot select text afterwards. Best for scans, notes and forms.'));
    },
    async run(ctx, ui){
      var lib = needPdfLib(), pdfjs = needPdfJs(), f = ctx.files[0];
      var pr = {good:{s:2,q:0.8}, balanced:{s:1.5,q:0.62}, small:{s:1.1,q:0.5}}[ctx.opts.level];
      var doc = await pdfjs.getDocument({data:new Uint8Array(await f.file.arrayBuffer())}).promise;
      var out = await lib.PDFDocument.create();
      for(var n=1;n<=doc.numPages;n++){
        ui.progress((n-1)/doc.numPages, 'Compressing page '+n+' of '+doc.numPages); await tick();
        var page = await doc.getPage(n), base = page.getViewport({scale:1});
        var blob = await renderJpeg(page, pr.s, pr.q);
        var img = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()));
        var p = out.addPage([base.width, base.height]);
        p.drawImage(img,{x:0,y:0,width:base.width,height:base.height});
        page.cleanup();
      }
      await doc.destroy();
      ui.progress(0.97, 'Saving your file'); await tick();
      var bytes = await out.save(), after = bytes.length;
      if(after >= f.size){
        return {summary:'Compressing did not help. The new file ('+fmt(after)+') is bigger than your original ('+fmt(f.size)+').', note:'This PDF is already well optimised. Try "Smallest file", or keep the original.', files:[]};
      }
      var saved = Math.round((1 - after/f.size)*100);
      return {summary:fmt(f.size)+' is now '+fmt(after)+'. That is '+saved+'% smaller.', note:'Pages are now pictures, so text cannot be selected or searched.', files:[{name:baseName(f.name)+'-compressed.pdf', blob:pdfBlob(bytes)}]};
    }},

  { id:'page-numbers', group:'Improve', name:'Add page numbers', blurb:'Print a page number on every page of your PDF.',
    kind:'pdf', drop:'Choose a PDF file', action:'Add page numbers',
    options(ctx){
      ctx.opts.pos = 'bottom-center'; ctx.opts.format = 'plain'; ctx.opts.start = '1';
      var pos = h('select',{onchange:function(e){ ctx.opts.pos = e.target.value; }},
        h('option',{value:'bottom-center'},'Bottom centre'),
        h('option',{value:'bottom-right'},'Bottom right'),
        h('option',{value:'bottom-left'},'Bottom left'),
        h('option',{value:'top-right'},'Top right'));
      var start = h('input',{type:'number',min:'0',max:'9999',value:'1',inputmode:'numeric',oninput:function(e){ ctx.opts.start = e.target.value; }});
      return h('div',{class:'opts'},
        field('Position', pos),
        radios('pn-format','Style',[
          {v:'plain', t:'1, 2, 3'}, {v:'of', t:'Page 1 of 10'}
        ],'plain',function(v){ ctx.opts.format = v; }),
        field('First page number', start));
    },
    async run(ctx, ui){
      var lib = needPdfLib(), f = ctx.files[0], doc = await loadPdf(f.file);
      var font = await doc.embedFont(lib.StandardFonts.Helvetica), pages = doc.getPages(), n = pages.length;
      var s = parseInt(ctx.opts.start,10); if(!isFinite(s) || s < 0) s = 1;
      ui.progress(0.5, 'Adding numbers'); await tick();
      pages.forEach(function(p,i){
        var label = ctx.opts.format === 'of' ? 'Page '+(s+i)+' of '+(s+n-1) : String(s+i);
        var size = 11, tw = font.widthOfTextAtSize(label,size), vs = visibleSize(p), m = 28, pos = ctx.opts.pos, vx;
        if(/left$/.test(pos)) vx = m; else if(/right$/.test(pos)) vx = vs.W - m - tw; else vx = (vs.W - tw)/2;
        var vy = /^top/.test(pos) ? vs.H - m - size*0.72 : m;
        var u = toUser(p, vx, vy);
        p.drawText(label,{x:u.x, y:u.y, size:size, font:font, color:lib.rgb(0.2,0.2,0.2), rotate:lib.degrees(u.rot)});
      });
      return {summary:'Added page numbers to '+n+' page'+(n===1?'':'s')+'.', files:[{name:baseName(f.name)+'-numbered.pdf', blob:pdfBlob(await doc.save())}]};
    }},

  { id:'watermark', group:'Improve', name:'Add watermark', blurb:'Stamp text like DRAFT or your name across every page.',
    kind:'pdf', drop:'Choose a PDF file', action:'Add watermark',
    options(ctx){
      ctx.opts.text = 'CONFIDENTIAL'; ctx.opts.opacity = 25; ctx.opts.diag = true;
      var val = h('span',{class:'hint'},'25%');
      var range = h('input',{type:'range',min:'10',max:'70',value:'25',oninput:function(e){ ctx.opts.opacity = +e.target.value; val.textContent = e.target.value+'%'; }});
      var txt = h('input',{type:'text',value:'CONFIDENTIAL',autocomplete:'off',maxlength:'40',oninput:function(e){ ctx.opts.text = e.target.value; }});
      return h('div',{class:'opts'},
        field('Watermark text', txt, 'English letters, numbers and common symbols.'),
        h('label',{class:'field'}, h('span',{class:'lbl'},'Strength'), range, val),
        h('label',{class:'check'}, h('input',{type:'checkbox',checked:true,onchange:function(e){ ctx.opts.diag = e.target.checked; }}), 'Slant the text diagonally'));
    },
    async run(ctx, ui){
      var lib = needPdfLib(), f = ctx.files[0], doc = await loadPdf(f.file);
      var text = (ctx.opts.text||'').trim();
      if(!text) throw new Error('Type the watermark text first.');
      var font = await doc.embedFont(lib.StandardFonts.HelveticaBold);
      try{ font.widthOfTextAtSize(text, 10); }catch(e){ throw new Error('The watermark can use English letters, numbers and common symbols only.'); }
      var pages = doc.getPages(), deg = ctx.opts.diag ? 45 : 0, th = deg*Math.PI/180, base = font.widthOfTextAtSize(text,100);
      ui.progress(0.5, 'Adding watermark'); await tick();
      pages.forEach(function(p){
        var vs = visibleSize(p), target = ctx.opts.diag ? 0.72*Math.min(vs.W,vs.H)*Math.SQRT2 : 0.75*vs.W;
        var size = Math.max(14, Math.min(160, 100*target/base));
        var tw = font.widthOfTextAtSize(text,size), tHt = size*0.7;
        var dx = Math.cos(th), dy = Math.sin(th), nx = -Math.sin(th), ny = Math.cos(th);
        var vx = vs.W/2 - dx*tw/2 - nx*tHt/2, vy = vs.H/2 - dy*tw/2 - ny*tHt/2;
        var u = toUser(p, vx, vy);
        p.drawText(text,{x:u.x, y:u.y, size:size, font:font, color:lib.rgb(0.45,0.45,0.45), opacity:ctx.opts.opacity/100, rotate:lib.degrees(u.rot+deg)});
      });
      return {summary:'Added the watermark to '+pages.length+' page'+(pages.length===1?'':'s')+'.', files:[{name:baseName(f.name)+'-watermarked.pdf', blob:pdfBlob(await doc.save())}]};
    }}
];

/* ---------- tool page engine ---------- */
function mountTool(def, root){
  var ctx = {files:[], opts:{}, busy:false, seq:0};
  var okFile = def.kind === 'pdf'
    ? function(f){ return /\.pdf$/i.test(f.name) || f.type === 'application/pdf'; }
    : function(f){ return /^image\//.test(f.type) || /\.(jpe?g|jfif|png|webp|gif|bmp|avif|heic|heif|svg|tiff?)$/i.test(f.name); };

  var input = h('input',{type:'file',class:'sr',accept:def.kind==='pdf'?'application/pdf,.pdf':'image/*,.heic,.heif,.avif,.webp,.gif,.bmp,.svg,.tif,.tiff,.jfif',multiple:def.multiple,
    onchange:function(){ add(Array.prototype.slice.call(input.files)); input.value=''; }});
  var dropMain = h('span',{class:'drop-main'}, def.drop);
  var drop = h('label',{class:'drop'}, input, dropMain, h('span',{class:'drop-sub'}, 'or drop '+(def.multiple?'them':'it')+' here'));
  ['dragenter','dragover'].forEach(function(t){ drop.addEventListener(t,function(e){ e.preventDefault(); drop.classList.add('over'); }); });
  ['dragleave','dragend'].forEach(function(t){ drop.addEventListener(t,function(){ drop.classList.remove('over'); }); });
  drop.addEventListener('drop',function(e){ e.preventDefault(); drop.classList.remove('over'); add(Array.prototype.slice.call(e.dataTransfer.files||[])); });

  var msg = h('p',{class:'msg',role:'status',hidden:true});
  var list = h('ol',{class:'files',hidden:true});
  var optEl = def.options ? def.options(ctx) : null;
  var optsBox = h('div',{hidden:true}, optEl);
  var go = h('button',{type:'button',class:'go',disabled:true}, def.action);
  var need = h('p',{class:'need'});
  var actions = h('div',{class:'actions',hidden:true}, go, need);
  var bar = h('progress',{max:'1',value:'0'});
  var barText = h('p',{role:'status','aria-live':'polite'});
  var status = h('div',{class:'status',hidden:true}, bar, barText);
  var result = h('div',{hidden:true});
  root.append(drop, msg, list, optsBox, actions, status, result);

  function say(t){ msg.textContent = t; msg.hidden = !t; }
  function clearResult(){ result.replaceChildren(); result.hidden = true; }

  function add(files){
    say(''); clearResult();
    var good = files.filter(okFile), bad = files.length - good.length;
    if(bad) say(bad+' file'+(bad>1?'s were':' was')+' skipped. This tool needs '+(def.kind==='pdf'?'PDF files.':'image files (JPG, PNG, WebP, HEIC and more).'));
    if(!def.multiple){ good = good.slice(0,1); if(good.length) ctx.files = []; }
    good.forEach(function(file){
      var e = {id:++ctx.seq, file:file, name:file.name, size:file.size, pages:null, error:null};
      ctx.files.push(e);
      if(def.kind === 'pdf') inspect(e); else prepImage(e);
    });
    refresh();
  }
  async function inspect(e){
    try{
      var lib = needPdfLib();
      var doc = await lib.PDFDocument.load(await e.file.arrayBuffer(), {ignoreEncryption:true, updateMetadata:false});
      if(doc.isEncrypted) e.error = 'Password-protected. Remove the password first.';
      else e.pages = doc.getPageCount();
    }catch(err){
      e.error = (err && /engine did not load/.test(err.message)) ? err.message : 'This file could not be read. It may be damaged.';
    }
    refresh();
  }
  async function prepImage(e){
    try{
      var buf = await e.file.arrayBuffer();
      var info = sniffFormat(new Uint8Array(buf.slice(0,300)), e.name);
      e.fmtName = info.name;
      if(info.name === 'TIFF') e.error = 'TIFF is not supported by browsers. Convert it to JPG or PNG first.';
      else e.blob = new Blob([buf], {type:info.mime});
    }catch(err){
      e.error = 'Could not read this file. Remove it and pick it again from your gallery.';
    }
    refresh();
  }
  function move(i,d){ var j = i+d, t = ctx.files[i]; ctx.files[i] = ctx.files[j]; ctx.files[j] = t; clearResult(); refresh(); }
  function remove(i){ ctx.files.splice(i,1); clearResult(); refresh(); }

  function row(f,i){
    var meta = f.error || [fmt(f.size), def.kind==='pdf' ? (f.pages ? f.pages+(f.pages===1?' page':' pages') : 'reading file') : (f.fmtName || 'reading file')].join(', ');
    var acts = [];
    if(def.reorder && ctx.files.length > 1){
      acts.push(h('button',{type:'button',class:'icon-btn','aria-label':'Move '+f.name+' up',disabled:ctx.busy||i===0,onclick:function(){ move(i,-1); }}, icon('up',18)));
      acts.push(h('button',{type:'button',class:'icon-btn','aria-label':'Move '+f.name+' down',disabled:ctx.busy||i===ctx.files.length-1,onclick:function(){ move(i,1); }}, icon('down',18)));
    }
    acts.push(h('button',{type:'button',class:'icon-btn','aria-label':'Remove '+f.name,disabled:ctx.busy,onclick:function(){ remove(i); }}, icon('x',18)));
    return h('li',{class:'file'+(f.error?' bad':'')},
      h('div',{class:'file-main'}, h('span',{class:'file-name'},f.name), h('span',{class:'file-meta'},meta)),
      h('div',{class:'file-actions'}, acts));
  }
  function refresh(){
    list.replaceChildren.apply(list, ctx.files.map(row));
    var has = ctx.files.length > 0;
    list.hidden = !has; actions.hidden = !has; optsBox.hidden = !has || !optEl;
    var pending = ctx.files.some(function(f){ return !f.error && (def.kind==='pdf' ? f.pages == null : !f.blob); });
    var bad = ctx.files.some(function(f){ return f.error; });
    var enough = ctx.files.length >= (def.min || 1);
    go.disabled = ctx.busy || pending || bad || !enough;
    need.textContent = !enough ? 'Add at least '+def.min+' files to continue.' : (bad ? 'Remove the file with the problem to continue.' : '');
    drop.classList.toggle('compact', has);
    dropMain.textContent = has && def.multiple ? 'Add more files' : (has ? 'Choose a different file' : def.drop);
  }

  var ui = { progress:function(p,t){ bar.value = Math.max(0,Math.min(1,p)); if(t) barText.textContent = t; } };

  function showResult(res){
    result.replaceChildren();
    result.hidden = false;
    var box = h('div',{class:'result'});
    var note = h('p',{class:'res-note',role:'status',hidden:true});
    box.append(h('p',{class:'res-title'}, res.summary));
    if(res.note) box.append(h('p',{class:'res-note'}, res.note));
    var rowEl = h('div',{class:'res-row'});
    (res.files||[]).forEach(function(f){
      rowEl.append(h('button',{type:'button',class:'go',onclick:async function(){
        note.hidden = false; note.textContent = '';
        try{ await saveFile(f.name, f.blob); note.textContent = 'Saved.'; }
        catch(e){
          if(e && e.code === 'declined') note.textContent = 'Download cancelled.';
          else if(e && e.code === 'unavailable') note.textContent = 'Downloads are not available in this view. Open the page in a new tab and try again.';
          else note.textContent = 'Could not save the file. Please try again.';
        }
      }}, 'Download '+f.name+' ('+fmt(f.blob.size)+')'));
    });
    rowEl.append(h('button',{type:'button',class:'ghost',onclick:function(){ ctx.files = []; clearResult(); say(''); refresh(); }}, 'Start over'));
    box.append(rowEl, note);
    result.append(box);
    result.scrollIntoView({block:'nearest'});
  }
  function showError(err){
    result.replaceChildren();
    result.hidden = false;
    result.append(h('div',{class:'result err'}, h('p',{class:'res-title'},'Could not '+def.action.charAt(0).toLowerCase()+def.action.slice(1)+'.'), h('p',{class:'res-note'}, (err && err.message) ? err.message : 'Something went wrong. Please try again with a smaller file.')));
    result.scrollIntoView({block:'nearest'});
  }

  go.addEventListener('click', async function(){
    say(''); clearResult();
    ctx.busy = true; refresh();
    status.hidden = false; ui.progress(0.02, 'Starting');
    try{
      var res = await def.run(ctx, ui);
      showResult(res);
    }catch(err){
      console.error(err);
      showError(err);
    }finally{
      ctx.busy = false; status.hidden = true; refresh();
    }
  });
}

/* ---------- PDF editor (add text, cover, highlight) ---------- */
function clamp(v,a,b){ return Math.max(a,Math.min(b,v)); }
function hexToRgb(hex){ var n = parseInt(hex.slice(1),16); return [((n>>16)&255)/255, ((n>>8)&255)/255, (n&255)/255]; }
function errBox(title, text){
  return h('div',{class:'result err'}, h('p',{class:'res-title'},title), h('p',{class:'res-note'},text));
}
function resultBox(res){
  var note = h('p',{class:'res-note',role:'status',hidden:true});
  var rowEl = h('div',{class:'res-row'});
  (res.files||[]).forEach(function(f){
    rowEl.append(h('button',{type:'button',class:'go',onclick:async function(){
      note.hidden = false; note.textContent = '';
      try{ await saveFile(f.name, f.blob); note.textContent = 'Saved.'; }
      catch(e){
        if(e && e.code === 'declined') note.textContent = 'Download cancelled.';
        else if(e && e.code === 'unavailable') note.textContent = 'Downloads are not available in this view. Open the page in a new tab and try again.';
        else note.textContent = 'Could not save the file. Please try again.';
      }
    }}, 'Download '+f.name+' ('+fmt(f.blob.size)+')'));
  });
  return h('div',{class:'result'}, h('p',{class:'res-title'},res.summary), res.note ? h('p',{class:'res-note'},res.note) : null, rowEl, note);
}
async function textToPng(text, size, color){
  var S = 4, fam = '"Noto Sans Devanagari","Nirmala UI",Mangal,"Segoe UI",Arial,Helvetica,sans-serif';
  var c = document.createElement('canvas'), cx = c.getContext('2d');
  cx.font = (size*S)+'px '+fam;
  var w = Math.max(2, Math.ceil(cx.measureText(text).width) + 4), hh = Math.ceil(size*S*1.5);
  c.width = w; c.height = hh;
  cx = c.getContext('2d');
  cx.font = (size*S)+'px '+fam; cx.fillStyle = color; cx.textBaseline = 'alphabetic';
  cx.fillText(text, 2, Math.round(size*S));
  var blob = await toBlob(c, 'image/png');
  c.width = c.height = 0;
  return {bytes:new Uint8Array(await blob.arrayBuffer()), wPt:w/S, hPt:hh/S};
}

function mountEditor(def, root){
  var COLORS = [['#000000','Black'],['#1a3fbf','Blue'],['#c7182b','Red']];
  var HINTS = {
    select:'Tap an item to select it, then drag to move it.',
    text:'Tap on the page where you want to type.',
    cover:'Drag over old text to hide it with a white box.',
    highlight:'Drag over text to highlight it.'
  };
  var ZOOMS = [1,1.5,2,3];
  var st = {file:null, doc:null, pageNo:1, pages:0, zoom:1, mode:'select', selected:null, seq:0, objs:{}, stack:[], vis:{W:595,H:842}, def:{size:14,color:'#000000'}, token:0, task:null, busy:false};
  var elMap = {};

  /* file picker */
  var input = h('input',{type:'file',class:'sr',accept:'application/pdf,.pdf',onchange:function(){ var f = input.files[0]; input.value = ''; if(f) openFile(f); }});
  var dropMain = h('span',{class:'drop-main'}, def.drop || 'Choose a PDF file');
  var drop = h('label',{class:'drop'}, input, dropMain, h('span',{class:'drop-sub'},'or drop it here'));
  ['dragenter','dragover'].forEach(function(t){ drop.addEventListener(t,function(e){ e.preventDefault(); drop.classList.add('over'); }); });
  ['dragleave','dragend'].forEach(function(t){ drop.addEventListener(t,function(){ drop.classList.remove('over'); }); });
  drop.addEventListener('drop',function(e){ e.preventDefault(); drop.classList.remove('over'); var f = e.dataTransfer.files && e.dataTransfer.files[0]; if(f) openFile(f); });
  var explain = h('p',{class:'hint ed-explain'},'PDF text cannot be changed directly. To fix a mistake, cover the old text with a white box, then type the new text on top.');
  var msg = h('p',{class:'msg',role:'status',hidden:true});

  /* toolbar */
  var btns = {};
  var seg = h('div',{class:'seg',role:'group','aria-label':'Editing tools'}, [['select','Move'],['text','Add text'],['cover','Cover'],['highlight','Highlight']].map(function(m){
    var b = h('button',{type:'button','aria-pressed':m[0]==='select'?'true':'false',onclick:function(){ setMode(m[0]); }}, m[1]);
    btns[m[0]] = b; return b;
  }));
  var hintEl = h('p',{class:'msg',role:'status'}, HINTS.select);
  var prevB = h('button',{type:'button',class:'tbtn','aria-label':'Previous page',onclick:function(){ goPage(st.pageNo-1); }}, icon('back',18));
  var nextB = h('button',{type:'button',class:'tbtn','aria-label':'Next page',onclick:function(){ goPage(st.pageNo+1); }}, icon('chev',18));
  var pageLbl = h('span',{class:'ed-lbl'},'');
  var zOut = h('button',{type:'button',class:'tbtn','aria-label':'Zoom out',onclick:function(){ zoomBy(-1); }}, '\u2212');
  var zIn = h('button',{type:'button',class:'tbtn','aria-label':'Zoom in',onclick:function(){ zoomBy(1); }}, '+');
  var zLbl = h('span',{class:'ed-lbl'},'100%');
  var undoB = h('button',{type:'button',class:'tbtn',onclick:undo}, 'Undo');
  var nav = h('div',{class:'ed-bar'}, prevB, pageLbl, nextB, h('span',{class:'ed-gap'}), zOut, zLbl, zIn, undoB);

  /* selected item panel */
  var txtIn = h('input',{type:'text',autocomplete:'off',spellcheck:'false',oninput:function(e){
    var o = st.selected; if(o && o.type === 'text'){ o.text = e.target.value; refreshEl(o); }
  }});
  var txtRow = field('Text', txtIn);
  var sizeLbl = h('span',{class:'ed-lbl'},'14 pt');
  var sizeDown = h('button',{type:'button',class:'tbtn','aria-label':'Smaller text',onclick:function(){ setSize(-2); }}, 'A\u2212');
  var sizeUp = h('button',{type:'button',class:'tbtn','aria-label':'Bigger text',onclick:function(){ setSize(2); }}, 'A+');
  var colorBtns = COLORS.map(function(c){
    return h('button',{type:'button',class:'swatch','aria-label':c[1]+' text','aria-pressed':'false','data-c':c[0],style:'background:'+c[0],onclick:function(){ setColor(c[0]); }});
  });
  var styleRow = h('div',{class:'ed-bar'}, sizeDown, sizeLbl, sizeUp, h('span',{class:'ed-gap'}), colorBtns);
  var delB = h('button',{type:'button',class:'ghost',onclick:delSel}, 'Delete this item');
  var ctxBox = h('div',{class:'ed-ctx',hidden:true}, txtRow, styleRow, h('div',null,delB));

  /* page view */
  var canvas = document.createElement('canvas');
  var overlay = h('div',{class:'ed-ov'});
  var stage = h('div',{class:'ed-stage','data-mode':'select'}, canvas, overlay);
  var view = h('div',{class:'ed-view'}, stage);

  /* save */
  var saveB = h('button',{type:'button',class:'go',onclick:save}, 'Save PDF');
  var statusEl = h('p',{class:'msg',role:'status',hidden:true}, 'Saving your file');
  var saveRow = h('div',{class:'actions'}, saveB, statusEl);
  var resultHost = h('div',{class:'ed-res'});
  var ed = h('div',{hidden:true}, seg, hintEl, nav, ctxBox, view, saveRow, resultHost);
  root.append(drop, explain, msg, ed);

  function say(t){ msg.textContent = t; msg.hidden = !t; }
  function pxPerPt(){ var w = stage.clientWidth; return w > 0 ? w/st.vis.W : 1; }
  function pos(e){ var r = overlay.getBoundingClientRect(); return {x:clamp((e.clientX-r.left)/r.width,0,1), y:clamp((e.clientY-r.top)/r.height,0,1)}; }
  function findObj(id){
    var ks = Object.keys(st.objs);
    for(var i=0;i<ks.length;i++){ var l = st.objs[ks[i]]; for(var j=0;j<l.length;j++){ if(l[j].id === id) return {page:+ks[i], list:l, index:j, obj:l[j]}; } }
    return null;
  }

  /* overlay elements */
  function applyEl(o, el){
    el.style.left = (o.x*100)+'%'; el.style.top = (o.y*100)+'%';
    if(o.type === 'text'){
      el.textContent = o.text || ' ';
      el.style.fontSize = (o.size*pxPerPt())+'px';
      el.style.color = o.color;
    } else {
      el.style.width = (o.w*100)+'%'; el.style.height = (o.h*100)+'%';
      el.style.background = o.kind === 'cover' ? '#fff' : 'rgba(255,225,77,.45)';
    }
  }
  function refreshEl(o){ var el = elMap[o.id]; if(el) applyEl(o, el); }
  function makeEl(o){
    var el = h('div',{class:'ed-obj '+(o.type==='text'?'ed-text':'ed-rect ed-'+o.kind)});
    applyEl(o, el);
    el.addEventListener('pointerdown', function(e){ onObjDown(e, o, el); });
    return el;
  }
  function drawOverlay(){
    overlay.replaceChildren(); elMap = {};
    (st.objs[st.pageNo] || []).forEach(function(o){ var el = makeEl(o); overlay.append(el); elMap[o.id] = el; });
    if(st.selected) select(st.selected);
  }
  function relayout(){
    (st.objs[st.pageNo] || []).forEach(function(o){ if(o.type === 'text') refreshEl(o); });
  }
  function addObj(o){
    (st.objs[o.page] = st.objs[o.page] || []).push(o);
    st.stack.push(o.id);
    var el = makeEl(o); overlay.append(el); elMap[o.id] = el;
    syncUi();
  }
  function onObjDown(e, o, el){
    if(e.button !== undefined && e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    select(o);
    var r = overlay.getBoundingClientRect(), sx = e.clientX, sy = e.clientY, ox = o.x, oy = o.y;
    try{ el.setPointerCapture(e.pointerId); }catch(err){}
    function move(ev){
      o.x = clamp(ox + (ev.clientX-sx)/r.width, 0, 1-(o.w||0.02));
      o.y = clamp(oy + (ev.clientY-sy)/r.height, 0, 1-(o.h||0.02));
      el.style.left = (o.x*100)+'%'; el.style.top = (o.y*100)+'%';
    }
    function up(){ el.removeEventListener('pointermove',move); el.removeEventListener('pointerup',up); el.removeEventListener('pointercancel',up); }
    el.addEventListener('pointermove',move); el.addEventListener('pointerup',up); el.addEventListener('pointercancel',up);
  }

  /* overlay gestures: tap to add text, drag to draw boxes */
  var tap = null;
  overlay.addEventListener('pointerdown', function(e){
    if(e.target !== overlay) return;
    if(st.mode === 'select'){ select(null); return; }
    if(st.mode === 'text'){ tap = {id:e.pointerId, x:e.clientX, y:e.clientY}; return; }
    startDraw(e);
  });
  overlay.addEventListener('pointerup', function(e){
    if(!tap || tap.id !== e.pointerId) return;
    var moved = Math.hypot(e.clientX-tap.x, e.clientY-tap.y); tap = null;
    if(moved > 10 || st.mode !== 'text') return;
    var p = pos(e);
    var o = {id:++st.seq, type:'text', page:st.pageNo, x:clamp(p.x,0,0.94), y:clamp(p.y,0,0.97), text:'Type here', size:st.def.size, color:st.def.color};
    addObj(o); select(o, true);
  });
  overlay.addEventListener('pointercancel', function(){ tap = null; });
  function startDraw(e){
    e.preventDefault();
    var p = pos(e), x0 = p.x, y0 = p.y;
    var o = {id:++st.seq, type:'rect', kind:st.mode, page:st.pageNo, x:x0, y:y0, w:0, h:0};
    var el = makeEl(o); overlay.append(el);
    try{ overlay.setPointerCapture(e.pointerId); }catch(err){}
    function move(ev){
      var q = pos(ev);
      o.x = Math.min(x0,q.x); o.y = Math.min(y0,q.y); o.w = Math.abs(q.x-x0); o.h = Math.abs(q.y-y0);
      applyEl(o, el);
    }
    function up(){
      overlay.removeEventListener('pointermove',move); overlay.removeEventListener('pointerup',up); overlay.removeEventListener('pointercancel',up);
      el.remove();
      if(o.w < 0.01 || o.h < 0.004) return;
      addObj(o); select(o);
    }
    overlay.addEventListener('pointermove',move); overlay.addEventListener('pointerup',up); overlay.addEventListener('pointercancel',up);
  }

  /* selection and style */
  function select(o, focus){
    st.selected = o || null;
    Object.keys(elMap).forEach(function(id){ elMap[id].classList.toggle('sel', !!o && +id === o.id); });
    ctxBox.hidden = !o;
    if(!o) return;
    var isText = o.type === 'text';
    txtRow.hidden = !isText; styleRow.hidden = !isText;
    if(isText){
      txtIn.value = o.text; sizeLbl.textContent = o.size+' pt';
      colorBtns.forEach(function(b){ b.setAttribute('aria-pressed', b.getAttribute('data-c') === o.color ? 'true' : 'false'); });
    }
    if(focus && isText){ txtIn.focus(); txtIn.select(); }
  }
  function setSize(d){
    var o = st.selected; if(!o || o.type !== 'text') return;
    o.size = clamp(o.size+d, 6, 120); st.def.size = o.size; sizeLbl.textContent = o.size+' pt'; refreshEl(o);
  }
  function setColor(c){
    var o = st.selected; if(!o || o.type !== 'text') return;
    o.color = c; st.def.color = c; refreshEl(o); select(o);
  }
  function removeObj(f){
    f.list.splice(f.index,1); select(null);
    if(f.page !== st.pageNo){ st.pageNo = f.page; syncUi(); renderPage(false); }
    else { drawOverlay(); syncUi(); }
  }
  function delSel(){ var f = st.selected && findObj(st.selected.id); if(f) removeObj(f); }
  function undo(){
    while(st.stack.length){ var f = findObj(st.stack.pop()); if(f){ removeObj(f); return; } }
  }
  function setMode(m){
    st.mode = m;
    Object.keys(btns).forEach(function(k){ btns[k].setAttribute('aria-pressed', k === m ? 'true' : 'false'); });
    stage.setAttribute('data-mode', m);
    overlay.classList.toggle('draw', m === 'cover' || m === 'highlight');
    hintEl.textContent = HINTS[m];
  }
  function syncUi(){
    pageLbl.textContent = 'Page '+st.pageNo+' of '+st.pages;
    prevB.disabled = st.pageNo <= 1; nextB.disabled = st.pageNo >= st.pages;
    var zi = ZOOMS.indexOf(st.zoom);
    zLbl.textContent = Math.round(st.zoom*100)+'%'; zOut.disabled = zi <= 0; zIn.disabled = zi >= ZOOMS.length-1;
    undoB.disabled = !st.stack.some(function(id){ return findObj(id); });
    saveB.disabled = st.busy;
  }
  function goPage(n){
    n = clamp(n, 1, st.pages); if(n === st.pageNo) return;
    select(null); st.pageNo = n; syncUi(); view.scrollTop = 0; renderPage(false);
  }
  function zoomBy(d){
    var i = ZOOMS.indexOf(st.zoom)+d; if(i < 0 || i >= ZOOMS.length) return;
    st.zoom = ZOOMS[i]; stage.style.width = (st.zoom*100)+'%'; syncUi(); renderPage(true);
  }

  /* rendering */
  async function renderPage(keep){
    var token = ++st.token;
    if(!keep){ overlay.replaceChildren(); elMap = {}; }
    if(st.task){ try{ st.task.cancel(); await st.task.promise; }catch(e){} st.task = null; }
    if(token !== st.token) return;
    var page = await st.doc.getPage(st.pageNo);
    if(token !== st.token) return;
    var base = page.getViewport({scale:1});
    st.vis = {W:base.width, H:base.height};
    var cssW = Math.max(300, stage.clientWidth || view.clientWidth || 600);
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var scale = clamp((cssW*dpr)/base.width, 0.5, 5);
    var vp = page.getViewport({scale:scale});
    if(vp.width*vp.height > 16e6){ scale *= Math.sqrt(16e6/(vp.width*vp.height)); vp = page.getViewport({scale:scale}); }
    canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
    var cx = canvas.getContext('2d', {alpha:false});
    cx.fillStyle = '#fff'; cx.fillRect(0,0,canvas.width,canvas.height);
    st.task = page.render({canvasContext:cx, viewport:vp});
    try{ await st.task.promise; }
    catch(e){ if(e && e.name === 'RenderingCancelledException') return; throw e; }
    if(token !== st.token) return;
    st.task = null;
    if(keep) relayout(); else drawOverlay();
  }
  if(window.ResizeObserver) new ResizeObserver(function(){ relayout(); }).observe(stage);

  /* open a file */
  async function openFile(f){
    say(''); resultHost.replaceChildren();
    if(!(/\.pdf$/i.test(f.name) || f.type === 'application/pdf')){ say('This tool needs a PDF file.'); return; }
    try{
      var lib = needPdfLib(), pdfjs = needPdfJs();
      var buf = await f.arrayBuffer();
      var chk = await lib.PDFDocument.load(buf, {ignoreEncryption:true, updateMetadata:false});
      if(chk.isEncrypted){ say('This PDF is password-protected. Remove the password first, then try again.'); return; }
      if(st.doc){ try{ st.doc.destroy(); }catch(e){} }
      st.doc = await pdfjs.getDocument({data:new Uint8Array(buf.slice(0))}).promise;
      st.file = f; st.pages = st.doc.numPages; st.pageNo = 1; st.objs = {}; st.stack = []; st.selected = null; st.zoom = 1;
      stage.style.width = '100%'; ctxBox.hidden = true;
      dropMain.textContent = 'Choose a different file'; drop.classList.add('compact'); explain.hidden = false;
      ed.hidden = false; setMode('select'); syncUi();
      await renderPage(false);
    }catch(err){
      console.error(err);
      say(err && /engine did not load/.test(err.message) ? err.message : 'This file could not be opened. It may be damaged.');
    }
  }

  /* save */
  async function save(){
    resultHost.replaceChildren(); st.busy = true; syncUi(); statusEl.hidden = false;
    try{
      var res = await saveDoc();
      resultHost.append(resultBox(res));
      resultHost.scrollIntoView({block:'nearest'});
    }catch(err){
      console.error(err);
      resultHost.append(errBox('Could not save PDF.', (err && err.message) ? err.message : 'Something went wrong. Please try again.'));
    }finally{
      st.busy = false; statusEl.hidden = true; syncUi();
    }
  }
  async function saveDoc(){
    var lib = needPdfLib(), total = 0;
    Object.keys(st.objs).forEach(function(k){ total += st.objs[k].length; });
    if(!total) throw new Error('Add some text, a white cover box or a highlight first.');
    var doc = await loadPdf(st.file);
    var font = await doc.embedFont(lib.StandardFonts.Helvetica), pages = doc.getPages(), keys = Object.keys(st.objs), used = 0;
    for(var ki=0; ki<keys.length; ki++){
      var pn = +keys[ki], list = st.objs[pn], p = pages[pn-1];
      if(!p || !list.length) continue;
      var vs = visibleSize(p);
      for(var i=0;i<list.length;i++){
        var o = list[i];
        if(o.type === 'rect'){
          var a = toUser(p, o.x*vs.W, vs.H - o.y*vs.H), b = toUser(p, (o.x+o.w)*vs.W, vs.H - (o.y+o.h)*vs.H);
          var cover = o.kind === 'cover';
          p.drawRectangle({x:Math.min(a.x,b.x), y:Math.min(a.y,b.y), width:Math.abs(a.x-b.x), height:Math.abs(a.y-b.y),
            color: cover ? lib.rgb(1,1,1) : lib.rgb(1,0.88,0.15), opacity: cover ? 1 : 0.4, borderWidth:0});
          used++;
        } else {
          var txt = (o.text || '').replace(/[\r\n]+/g,' ');
          if(!txt.trim()) continue;
          var c = hexToRgb(o.color), ok = true;
          try{ font.widthOfTextAtSize(txt, o.size); }catch(e){ ok = false; }
          var vx = o.x*vs.W, yTop = o.y*vs.H;
          if(ok){
            var u = toUser(p, vx, vs.H - (yTop + o.size*0.85));
            p.drawText(txt,{x:u.x, y:u.y, size:o.size, font:font, color:lib.rgb(c[0],c[1],c[2]), rotate:lib.degrees(u.rot)});
          } else {
            var png = await textToPng(txt, o.size, o.color), emb = await doc.embedPng(png.bytes);
            var u2 = toUser(p, vx, vs.H - (yTop - 0.15*o.size + png.hPt));
            p.drawImage(emb,{x:u2.x, y:u2.y, width:png.wPt, height:png.hPt, rotate:lib.degrees(u2.rot)});
          }
          used++;
        }
      }
    }
    var bytes = await doc.save();
    return {summary:'Saved your changes ('+used+' item'+(used===1?'':'s')+' added).', files:[{name:baseName(st.file.name)+'-edited.pdf', blob:pdfBlob(bytes)}]};
  }
}

/* ---------- start ---------- */
function boot(){
  var id = document.body.getAttribute('data-tool');
  var root = document.getElementById('tool-root');
  if(!id || !root) return;
  var def = TOOLS.filter(function(t){ return t.id === id; })[0];
  if(!def) return;
  if(def.custom) mountEditor(def, root); else mountTool(def, root);
}
if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
