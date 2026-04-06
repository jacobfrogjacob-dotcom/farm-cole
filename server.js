const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    const filePath = path.join(__dirname, 'public', 'index.html');
    if (fs.existsSync(filePath)) {
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(500); res.end('Error'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(data);
      });
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h1>WebSocket Server Running</h1><p>Connect via WebSocket on port ' + PORT + '</p>');
    }
  } else {
    const filePath = path.join(__dirname, req.url);
    if (fs.existsSync(filePath)) {
      const ext = path.extname(filePath);
      const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.mp3': 'audio/mpeg', '.ttf': 'font/ttf', '.png': 'image/png', '.jpg': 'image/jpeg' };
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(500); res.end('Error'); return; }
        res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
        res.end(data);
      });
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  }
});

const wss = new WebSocket.Server({ server });

// 玩家資料庫
const players = new Map(); // id -> { id, name, password, gold, bio, avatar, farmName, wx, wy, color, ws, lastSeen }
// 好友關係
const friendships = new Map(); // playerId -> Set of friendIds
// 聊天記錄
const chatHistory = [];
// 交易請求
const tradeRequests = new Map(); // id -> { from, to, gold, status }
// 世界狀態
const worldState = {
  tiles: {}, // "wx,wy" -> { type, watered, crop }
  animals: [] // [{type, wx, wy}]
};

let playerIdCounter = 1;

function generateId() {
  return 'p_' + (playerIdCounter++);
}

function hashPassword(pwd) {
  // 簡單哈希（生產環境應用bcrypt）
  let hash = 0;
  for (let i = 0; i < pwd.length; i++) {
    hash = ((hash << 5) - hash) + pwd.charCodeAt(i);
    hash |= 0;
  }
  return hash.toString();
}

function broadcast(data, exclude = null) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client !== exclude) {
      client.send(msg);
    }
  });
}

function sendTo(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function getOnlinePlayers() {
  const list = [];
  players.forEach((p, id) => {
    if (p.ws && p.ws.readyState === WebSocket.OPEN) {
      list.push({ id, name: p.name, avatar: p.avatar, farmName: p.farmName, wx: p.wx, wy: p.wy, color: p.color });
    }
  });
  return list;
}

function getFriendsWithStatus(playerId) {
  const friends = [];
  const friendIds = friendships.get(playerId) || new Set();
  friendIds.forEach(friendId => {
    const friend = players.get(friendId);
    if (friend) {
      friends.push({
        id: friendId,
        name: friend.name,
        avatar: friend.avatar,
        farmName: friend.farmName,
        online: friend.ws && friend.ws.readyState === WebSocket.OPEN
      });
    }
  });
  return friends;
}

function saveData() {
  const data = {
    players: Array.from(players.entries()).map(([id, p]) => ({
      id, name: p.name, password: p.password, gold: p.gold || 100,
      bio: p.bio || '', avatar: p.avatar || 0, farmName: p.farmName || '我的農場'
    })),
    friendships: Array.from(friendships.entries()).map(([id, friends]) => [id, Array.from(friends)]),
    worldState: worldState
  };
  fs.writeFileSync('data.json', JSON.stringify(data, null, 2));
}

function loadData() {
  if (fs.existsSync('data.json')) {
    try {
      const data = JSON.parse(fs.readFileSync('data.json', 'utf8'));
      data.players?.forEach(p => {
        p.gold = p.gold || 100;
        p.bio = p.bio || '';
        p.avatar = p.avatar || 0;
        p.farmName = p.farmName || '我的農場';
        players.set(p.id, p);
      });
      data.friendships?.forEach(([id, friends]) => {
        friendships.set(id, new Set(friends));
      });
      if(data.worldState){
        if(data.worldState.tiles) worldState.tiles = data.worldState.tiles;
        if(data.worldState.animals) worldState.animals = data.worldState.animals;
      }
      playerIdCounter = players.size + 1;
      console.log('Loaded ' + players.size + ' players');
      console.log('Loaded ' + Object.keys(worldState.tiles).length + ' tiles');
    } catch (e) {
      console.log('Error loading data:', e.message);
    }
  }
}

// 定時保存
setInterval(saveData, 30000);

wss.on('connection', (ws) => {
  let playerId = null;

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      
      switch (data.type) {
        case 'join': {
          // 簡單加入（v19客戶端用）
          playerId = 'p_' + (++playerIdCounter);
          // 島嶼中心約在 (8, -7) 附近
          const startX = 8 + (Math.random() - 0.5) * 2;
          const startY = -7 + (Math.random() - 0.5) * 2;
          const player = {
            id: playerId,
            name: data.name || '玩家',
            color: data.color || '#' + Math.floor(Math.random()*16777215).toString(16).padStart(6, '0'),
            wx: startX,
            wy: startY,
            ws
          };
          players.set(playerId, player);
          
          // 發送當前在線玩家列表
          const list = [];
          players.forEach((p, id) => {
            if (p.ws && p.ws.readyState === WebSocket.OPEN && id !== playerId) {
              list.push({ id, name: p.name, color: p.color, wx: p.wx, wy: p.wy });
            }
          });
          sendTo(ws, { type: 'players', list });
          
          // 發送世界狀態給新玩家
          sendTo(ws, { type: 'world_state', tiles: worldState.tiles, animals: worldState.animals });
          
          // 廣播新玩家加入
          broadcast({ type: 'player_move', id: playerId, name: player.name, color: player.color, wx: startX, wy: startY }, ws);
          console.log('Player joined:', player.name, 'at', startX, startY, '- tiles:', Object.keys(worldState.tiles).length);
          break;
        }

        case 'pos': {
          // 位置更新
          const p = players.get(playerId);
          if (p) {
            p.wx = data.wx || 0;
            p.wy = data.wy || 0;
            broadcast({ type: 'player_move', id: playerId, wx: p.wx, wy: p.wy }, ws);
          }
          break;
        }

        case 'hoe':
        case 'plant':
        case 'water':
        case 'harvest':
        case 'fill':
        case 'catch': {
          const tileKey = data.wx + ',' + data.wy;
          
          // 更新伺服器世界狀態
          if(data.type === 'hoe' || data.type === 'fill'){
            worldState.tiles[tileKey] = worldState.tiles[tileKey] || {};
            worldState.tiles[tileKey].type = data.type === 'hoe' ? 'tilled' : 'land';
            worldState.tiles[tileKey].watered = false;
            worldState.tiles[tileKey].crop = null;
          } else if(data.type === 'plant' && data.plantId){
            worldState.tiles[tileKey] = worldState.tiles[tileKey] || {type:'tilled'};
            worldState.tiles[tileKey].crop = {id: data.plantId, waterAt: Date.now(), elapsed: 0};
          } else if(data.type === 'water'){
            if(worldState.tiles[tileKey]) worldState.tiles[tileKey].watered = true;
          } else if(data.type === 'harvest'){
            if(worldState.tiles[tileKey]) worldState.tiles[tileKey].crop = null;
          } else if(data.type === 'catch'){
            worldState.animals = worldState.animals.filter(a => a.wx !== data.wx || a.wy !== data.wy);
          }
          
          // 遊戲動作 - 廣播給所有玩家
          broadcast({ 
            type: 'game_action', 
            action: data.type,
            playerId: playerId,
            playerName: players.get(playerId)?.name || '玩家',
            wx: data.wx,
            wy: data.wy,
            plantId: data.plantId,
            sx: data.sx,
            sy: data.sy
          });
          break;
        }

        case 'register': {
          // 註冊
          const { name, password } = data;
          if (!name || !password) {
            sendTo(ws, { type: 'error', message: '請填寫名稱和密碼' });
            return;
          }
          // 檢查名稱是否已被使用
          for (const [id, p] of players) {
            if (p.name === name) {
              sendTo(ws, { type: 'error', message: '名稱已被使用' });
              return;
            }
          }
          // 創建玩家
          playerId = generateId();
          const player = {
            id: playerId,
            name,
            password: hashPassword(password),
            gold: 100,
            bio: '我是快樂的農夫！',
            avatar: 0,
            farmName: name + '的農場',
            wx: 0,
            wy: 0,
            color: '#' + Math.floor(Math.random()*16777215).toString(16).padStart(6, '0'),
            ws
          };
          players.set(playerId, player);
          friendships.set(playerId, new Set());
          saveData();
          
          sendTo(ws, { 
            type: 'register_success', 
            playerId,
            player: { id: playerId, name: player.name, gold: player.gold, bio: player.bio, avatar: player.avatar, farmName: player.farmName, color: player.color },
            friends: getFriendsWithStatus(playerId),
            onlinePlayers: getOnlinePlayers(),
            chatHistory: chatHistory.slice(-50)
          });
          console.log('Player registered:', name);
          break;
        }

        case 'login': {
          // 登入
          const { name, password } = data;
          const hashedPwd = hashPassword(password);
          let found = null;
          for (const [id, p] of players) {
            if (p.name === name && p.password === hashedPwd) {
              found = p;
              playerId = id;
              break;
            }
          }
          if (!found) {
            sendTo(ws, { type: 'error', message: '名稱或密碼錯誤' });
            return;
          }
          // 更新連線
          found.ws = ws;
          found.lastSeen = Date.now();
          
          sendTo(ws, { 
            type: 'login_success', 
            playerId,
            player: { id: found.id, name: found.name, gold: found.gold, bio: found.bio, avatar: found.avatar, farmName: found.farmName, color: found.color },
            friends: getFriendsWithStatus(playerId),
            onlinePlayers: getOnlinePlayers(),
            chatHistory: chatHistory.slice(-50)
          });
          
          // 廣播玩家上線
          broadcast({ type: 'player_online', id: found.id, name: found.name, avatar: found.avatar, color: found.color }, ws);
          console.log('Player logged in:', name);
          break;
        }

        case 'chat': {
          // 聊天
          if (!playerId) return;
          const player = players.get(playerId);
          if (!player) return;
          
          const chatMsg = {
            type: 'chat',
            id: Date.now(),
            senderId: playerId,
            sender: player.name,
            text: data.text.substring(0, 200),
            time: Date.now()
          };
          chatHistory.push(chatMsg);
          if (chatHistory.length > 200) chatHistory.shift();
          
          broadcast(chatMsg);
          break;
        }

        case 'pm': {
          // 私訊
          if (!playerId) return;
          const player = players.get(playerId);
          if (!player) return;
          
          const targetId = data.to;
          const target = players.get(targetId);
          if (!target || !target.ws) {
            sendTo(ws, { type: 'error', message: '玩家不在線' });
            return;
          }
          
          sendTo(target.ws, {
            type: 'pm',
            id: Date.now(),
            fromId: playerId,
            from: player.name,
            text: data.text.substring(0, 200),
            time: Date.now()
          });
          break;
        }

        case 'update_profile': {
          // 更新個人資料
          if (!playerId) return;
          const player = players.get(playerId);
          if (!player) return;
          
          if (data.bio !== undefined) player.bio = data.bio.substring(0, 50);
          if (data.avatar !== undefined) player.avatar = data.avatar;
          if (data.farmName !== undefined) player.farmName = data.farmName.substring(0, 20);
          
          saveData();
          broadcast({ type: 'player_updated', id: playerId, bio: player.bio, avatar: player.avatar, farmName: player.farmName });
          break;
        }

        case 'add_friend': {
          // 添加好友
          if (!playerId) return;
          const friendName = data.name;
          let friendId = null;
          for (const [id, p] of players) {
            if (p.name === friendName) {
              friendId = id;
              break;
            }
          }
          if (!friendId) {
            sendTo(ws, { type: 'error', message: '找不到玩家 ' + friendName });
            return;
          }
          if (friendId === playerId) {
            sendTo(ws, { type: 'error', message: '不能加自己為好友' });
            return;
          }
          
          // 雙向好友
          if (!friendships.get(playerId)) friendships.set(playerId, new Set());
          if (!friendships.get(friendId)) friendships.set(friendId, new Set());
          friendships.get(playerId).add(friendId);
          friendships.get(friendId).add(playerId);
          saveData();
          
          const friend = players.get(friendId);
          sendTo(ws, { type: 'friend_added', friend: { id: friendId, name: friend.name, avatar: friend.avatar, farmName: friend.farmName, online: friend.ws && friend.ws.readyState === WebSocket.OPEN }});
          
          if (friend.ws) {
            sendTo(friend.ws, { type: 'friend_added', friend: { id: playerId, name: player.name, avatar: player.avatar, farmName: player.farmName, online: true }});
          }
          break;
        }

        case 'remove_friend': {
          // 刪除好友
          if (!playerId) return;
          const removeId = data.id;
          
          if (friendships.get(playerId)) friendships.get(playerId).delete(removeId);
          if (friendships.get(removeId)) friendships.get(removeId).delete(playerId);
          saveData();
          
          sendTo(ws, { type: 'friend_removed', id: removeId });
          const removed = players.get(removeId);
          if (removed && removed.ws) {
            sendTo(removed.ws, { type: 'friend_removed', id: playerId });
          }
          break;
        }

        case 'visit': {
          // 拜訪玩家
          if (!playerId) return;
          const hostId = data.id;
          const host = players.get(hostId);
          if (!host) {
            sendTo(ws, { type: 'error', message: '玩家不存在' });
            return;
          }
          
          sendTo(ws, { type: 'visit_start', hostId, hostName: host.name, wx: host.wx, wy: host.wy });
          if (host.ws) {
            sendTo(host.ws, { type: 'visitor_arrived', visitorId: playerId, visitorName: player.name });
          }
          break;
        }

        case 'update_position': {
          // 更新位置
          if (!playerId) return;
          const player = players.get(playerId);
          if (!player) return;
          player.wx = data.wx || 0;
          player.wy = data.wy || 0;
          break;
        }

        case 'trade_request': {
          // 發送交易請求
          if (!playerId) return;
          const toId = data.to;
          const gold = parseInt(data.gold) || 0;
          const fromPlayer = players.get(playerId);
          const toPlayer = players.get(toId);
          
          if (!toPlayer || !toPlayer.ws) {
            sendTo(ws, { type: 'error', message: '玩家不在線' });
            return;
          }
          if (gold <= 0 || gold > fromPlayer.gold) {
            sendTo(ws, { type: 'error', message: '金幣不足' });
            return;
          }
          
          const tradeId = 't_' + Date.now();
          tradeRequests.set(tradeId, { from: playerId, to: toId, gold, status: 'pending' });
          
          sendTo(toPlayer.ws, {
            type: 'trade_request',
            tradeId,
            from: playerId,
            fromName: fromPlayer.name,
            gold
          });
          sendTo(ws, { type: 'trade_sent', tradeId, to: toPlayer.name });
          break;
        }

        case 'trade_accept': {
          // 接受交易
          if (!playerId) return;
          const tradeId = data.tradeId;
          const trade = tradeRequests.get(tradeId);
          
          if (!trade || trade.to !== playerId || trade.status !== 'pending') {
            sendTo(ws, { type: 'error', message: '交易無效' });
            return;
          }
          
          const fromPlayer = players.get(trade.from);
          const toPlayer = players.get(trade.to);
          
          if (!fromPlayer || fromPlayer.gold < trade.gold) {
            sendTo(ws, { type: 'error', message: '對方金幣不足' });
            trade.status = 'cancelled';
            return;
          }
          
          // 執行交易
          fromPlayer.gold -= trade.gold;
          toPlayer.gold += trade.gold;
          trade.status = 'completed';
          
          sendTo(fromPlayer.ws, { type: 'trade_accepted', tradeId, gold: trade.gold, yourGold: fromPlayer.gold });
          sendTo(toPlayer.ws, { type: 'trade_received', tradeId, fromName: fromPlayer.name, gold: trade.gold, yourGold: toPlayer.gold });
          
          saveData();
          console.log('Trade completed:', fromPlayer.name, '->', toPlayer.name, '💵' + trade.gold);
          break;
        }

        case 'trade_decline': {
          // 拒絕交易
          if (!playerId) return;
          const tradeId = data.tradeId;
          const trade = tradeRequests.get(tradeId);
          
          if (trade && trade.to === playerId) {
            trade.status = 'declined';
            const fromPlayer = players.get(trade.from);
            if (fromPlayer && fromPlayer.ws) {
              sendTo(fromPlayer.ws, { type: 'trade_declined', tradeId });
            }
          }
          break;
        }
      }
    } catch (e) {
      console.log('Error handling message:', e.message);
    }
  });

  ws.on('close', () => {
    if (playerId) {
      const player = players.get(playerId);
      if (player) {
        player.ws = null;
        player.lastSeen = Date.now();
        broadcast({ type: 'player_leave', id: playerId });
        console.log('Player disconnected:', player.name);
      }
    }
  });
});

loadData();

server.listen(PORT, () => {
  console.log('=================================');
  console.log('  🌾 島嶼農場 伺服器 🌾');
  console.log('=================================');
  console.log('  WebSocket: ws://localhost:' + PORT);
  console.log('  HTTP: http://localhost:' + PORT);
  console.log('=================================');
  console.log('  指令:');
  console.log('  node server.js');
  console.log('=================================');
});
