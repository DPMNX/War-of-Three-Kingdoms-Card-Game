'use strict';
/* ============================================================
   三国杀 + 斗地主 · 局域网联机中继服务器（纯 Node，零依赖）
   协议（长轮询）：
     POST /join  {room, create?, size?}  -> {seat: 0..size-1}
         create=true 建房(占0号位)；否则加入(房间须已存在)；size∈{2,3}，默认2
     POST /send  {room, seat, msg}      -> {ok}  把 msg 转发给房间内其他所有座位
     POST /leave {room, seat}           -> {ok}  释放座位并通知其他人（peerLeft）
     GET  /poll  ?room=&seat=           -> {msgs:[...]}  取回发给自己的消息（长轮询）
   用法：
     node server.js            # 端口默认 8000
     PORT=9000 node server.js  # 自定义端口
   ============================================================ */
const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '8000', 10) || 8000;
const LONG_POLL_MS = 25000;
const MAX_BODY = 1e6;

// room -> { size, seats: [...], lastActive }
const rooms = new Map();

function newSeat(){ return { occupied:false, inbox:[], waiters:[] }; }
function getRoom(room, size){
  let r = rooms.get(room);
  if(!r){
    r = { size:(size===3?3:2), seats:[], lastActive: Date.now() };
    for(let i=0;i<r.size;i++) r.seats.push(newSeat());
    rooms.set(room, r);
  }
  r.lastActive = Date.now();
  return r;
}
function wakeSeat(s){
  if(!s) return;
  s.waiters.forEach(w => w());
  s.waiters = [];
}
function sendJSON(res, code, obj){
  const body = JSON.stringify(obj);
  res.writeHead(code, {'Content-Type':'application/json; charset=utf-8'});
  res.end(body);
}

const server = http.createServer((req, res) => {
  // CORS（file:// 打开 index.html 时跨源访问本机服务）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if(req.method === 'OPTIONS'){ res.writeHead(204); res.end(); return; }

  const u = url.parse(req.url, true);

  // ---- 加入 / 建房 ----
  if(u.pathname === '/join' && req.method === 'POST'){
    readBody(req).then(body => {
      if(body === null) return sendJSON(res, 413, {error:'请求过大'});
      let room, create = false, size = 2;
      try { const o = JSON.parse(body || '{}'); room = String(o.room || ''); create = !!o.create; size = parseInt(o.size, 10) || 2; }
      catch(e){ return sendJSON(res, 400, {error:'bad json'}); }
      if(size !== 2 && size !== 3) size = 2;
      if(!room || room.length > 32 || !/^[A-Za-z0-9_-]+$/.test(room)) return sendJSON(res, 400, {error:'bad room'});
      if(create){
        const r0 = rooms.get(room);
        if(r0 && r0.seats[0].occupied) return sendJSON(res, 409, {error:'房间已存在'});
        const r = getRoom(room, size);
        r.seats[0].occupied = true;
        return sendJSON(res, 200, {seat:0, size:r.size});
      }
      // 加入：房间必须已存在（主机先创建），否则 404
      const r = rooms.get(room);
      if(!r) return sendJSON(res, 404, {error:'房间不存在'});
      if(r.size !== size) return sendJSON(res, 409, {error:'房间人数不符'});
      const seat = r.seats.findIndex(s => !s.occupied);
      if(seat === -1) return sendJSON(res, 409, {error:'房间已满'});
      r.seats[seat].occupied = true;
      sendJSON(res, 200, {seat, size:r.size});
    });
    return;
  }

  // ---- 离开 ----
  if(u.pathname === '/leave' && req.method === 'POST'){
    readBody(req).then(body => {
      if(body === null) return sendJSON(res, 413, {error:'请求过大'});
      let room, seat;
      try { const o = JSON.parse(body || '{}'); room = String(o.room || ''); seat = parseInt(o.seat, 10); }
      catch(e){ return sendJSON(res, 400, {error:'bad json'}); }
      const r = rooms.get(room);
      if(!r) return sendJSON(res, 404, {error:'房间不存在'});
      const s = r.seats[seat];
      if(s){
        s.occupied = false;
        s.inbox = [];
        wakeSeat(s);
        for(let i=0;i<r.seats.length;i++){
          if(i!==seat && r.seats[i].occupied){ r.seats[i].inbox.push({type:'peerLeft', seat}); wakeSeat(r.seats[i]); }
        }
      }
      sendJSON(res, 200, {ok:true});
    });
    return;
  }

  // ---- 发送消息给房间内其他座位（msg.to 为有效座位时只定向发给该座位） ----
  if(u.pathname === '/send' && req.method === 'POST'){
    readBody(req).then(body => {
      if(body === null) return sendJSON(res, 413, {error:'请求过大'});
      let room, seat, msg;
      try { const o = JSON.parse(body || '{}'); room = String(o.room || ''); seat = parseInt(o.seat, 10); msg = o.msg; }
      catch(e){ return sendJSON(res, 400, {error:'bad json'}); }
      if(!room || !Number.isInteger(seat)) return sendJSON(res, 400, {error:'bad request'});
      if(!msg || typeof msg !== 'object') return sendJSON(res, 400, {error:'bad msg'});
      const r = rooms.get(room);
      if(!r) return sendJSON(res, 404, {error:'房间不存在'});
      if(seat < 0 || seat >= r.seats.length) return sendJSON(res, 400, {error:'bad seat'});
      r.lastActive = Date.now();
      let to = -1;
      if(Number.isInteger(msg.to)) to = msg.to;
      for(let i=0;i<r.seats.length;i++){
        if(i===seat) continue;
        if(to>=0 && i!==to) continue;
        r.seats[i].inbox.push(msg);
        wakeSeat(r.seats[i]);
      }
      sendJSON(res, 200, {ok:true});
    });
    return;
  }

  // ---- 长轮询取消息 ----
  if(u.pathname === '/poll' && req.method === 'GET'){
    const room = String(u.query.room || '');
    const seat = parseInt(u.query.seat, 10);
    const r = rooms.get(room);
    if(!r) return sendJSON(res, 404, {error:'房间不存在'});
    r.lastActive = Date.now();
    const me = r.seats[seat];
    if(!me) return sendJSON(res, 400, {error:'bad seat'});
    if(me.inbox.length){
      const msgs = me.inbox.splice(0);
      return sendJSON(res, 200, {msgs});
    }
    const waiter = () => sendJSON(res, 200, {msgs: me.inbox.splice(0)});
    me.waiters.push(waiter);
    const to = setTimeout(() => {
      const i = me.waiters.indexOf(waiter);
      if(i >= 0){ me.waiters.splice(i, 1); sendJSON(res, 200, {msgs:[]}); }
    }, LONG_POLL_MS);
    res.on('close', () => {
      clearTimeout(to);
      const i = me.waiters.indexOf(waiter);
      if(i >= 0) me.waiters.splice(i, 1);
    });
    return;
  }

  if(u.pathname === '/health' && req.method === 'GET'){
    sendJSON(res, 200, {ok:true, rooms: rooms.size});
    return;
  }

  // ---- 列出 music/ 里的音频文件（BGM 自动发现）----
  if(u.pathname === '/music-list' && req.method === 'GET'){
    try{
      const dir = path.join(__dirname, 'music');
      const exts = ['.mp3','.opus','.ogg','.flac','.wav','.m4a'];
      let files = [];
      if(fs.existsSync(dir)) files = fs.readdirSync(dir).filter(f => exts.includes(path.extname(f).toLowerCase())).sort();
      sendJSON(res, 200, {files});
    }catch(e){ sendJSON(res, 200, {files:[]}); }
    return;
  }

  // ---- 静态文件：优先返回真实文件（mp3/png 等），其余返回游戏页面（SPA）----
  if(req.method === 'GET'){
    if(u.pathname === '/favicon.ico'){ res.writeHead(204); res.end(); return; }
    let pathname;
    try { pathname = decodeURIComponent(u.pathname); }
    catch(e){ pathname = '/'; } // 非法编码（如 GET /%）→ 回退游戏页面，避免 URIError 崩溃
    const filePath = path.normalize(path.join(__dirname, pathname));
    // 防路径穿越：只允许访问服务器目录内的文件（带分隔符，防止误放行同名前缀的兄弟目录）
    const rootPrefix = __dirname.endsWith(path.sep) ? __dirname : __dirname + path.sep;
    if(filePath.startsWith(rootPrefix) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()){
      const ext = path.extname(filePath).toLowerCase();
      const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.mp3':'audio/mpeg','.wav':'audio/wav','.ogg':'audio/ogg','.opus':'audio/ogg','.flac':'audio/flac','.m4a':'audio/mp4','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml','.ico':'image/x-icon','.json':'application/json; charset=utf-8'};
      res.writeHead(200, {'Content-Type': types[ext] || 'application/octet-stream'});
      fs.createReadStream(filePath).pipe(res);
      return;
    }
    try{
      const html = fs.readFileSync(path.join(__dirname, 'index.html'));
      res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
      res.end(html);
    }catch(e){ res.writeHead(500, {'Content-Type':'text/plain; charset=utf-8'}); res.end('index.html 不存在'); }
    return;
  }

  sendJSON(res, 404, {error:'not found'});
});

function readBody(req){
  return new Promise(resolve => {
    let data = '';
    let tooBig = false;
    req.on('data', d => {
      if(tooBig) return;
      data += d;
      if(data.length > MAX_BODY){ tooBig = true; resolve(null); } // 立即回 413，不再累积（不销毁连接，保证响应能送达）
    });
    req.on('end', () => resolve(tooBig ? null : data));
    req.on('error', () => resolve(tooBig ? null : ''));
  });
}

// 清理超过 2 小时无活动的房间
setInterval(() => {
  const now = Date.now();
  for(const [k, v] of rooms){
    if(now - v.lastActive > 2 * 3600 * 1000) rooms.delete(k);
  }
}, 10 * 60 * 1000).unref();

server.listen(PORT, '0.0.0.0', () => {
  const os = require('os');
  const ifs = os.networkInterfaces();
  console.log('==============================================');
  console.log('  三国杀 + 斗地主 · 联机服务器已启动（自带游戏页面）');
  console.log('  端口：' + PORT);
  console.log('----------------------------------------------');
  console.log('  主机自己（本机）浏览器打开：');
  console.log('    http://localhost:' + PORT);
  console.log('----------------------------------------------');
  console.log('  给对方的地址（选和对方同一 WiFi 的那个）：');
  for(const k in ifs){
    for(const a of ifs[k]){
      if(a.family === 'IPv4' && !a.internal){
        const tag = /^192\.168\./.test(a.address) ? '  ← 家里WiFi，一般用这个' : (/^(172\.1[6-9]|172\.2|172\.3[01])\./.test(a.address) ? '  （虚拟网卡，一般不用）' : (/^26\./.test(a.address) ? '  （Radmin VPN，对方也装了才行）' : ''));
        console.log('    http://' + a.address + ':' + PORT + '   (' + k + ')' + tag);
      }
    }
  }
  console.log('==============================================');
  console.log('  对方什么都不用下载！浏览器打开上面的地址即可。');
  console.log('  三国杀：主机「创建房间」→ 对方「加入房间」。');
  console.log('  斗地主：主机「创建斗地主房间」→ 两位玩家「加入斗地主房间」。');
  console.log('==============================================');
});
