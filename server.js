/**
 * ULTRA BINGO - Fixed Backend Server
 * Fixes: socketToPhone auth, auto-matchmaking, selectCard player bug,
 *        socket.join on card select, password hashing, roomJoined event
 */

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
const bodyParser = require('body-parser');
const path       = require('path');
const crypto     = require('crypto');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(bodyParser.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ══════════════════════════════════════════
//   DATA STORE
// ══════════════════════════════════════════
const users        = new Map(); // phone  → user object
const sessions     = new Map(); // token  → phone
const rooms        = new Map(); // roomId → Room
const deposits     = new Map(); // id     → deposit
const withdrawals  = [];
const socketToPhone = new Map(); // socketId → phone  ← NEW: tracks who each socket belongs to

const ADMIN_KEY = process.env.ADMIN_KEY || '8084877485';

// ══════════════════════════════════════════
//   PURE HELPERS
// ══════════════════════════════════════════
function hashPw(pw) {
  return crypto.createHash('sha256').update(pw + ':ub_salt_v2').digest('hex');
}
function genRefCode()   { return 'UB-' + crypto.randomBytes(3).toString('hex').toUpperCase(); }
function genToken()     { return crypto.randomBytes(20).toString('hex'); }
function genRoomId()    { return 'R'  + crypto.randomBytes(3).toString('hex').toUpperCase(); }
function genDepositId() { return 'D'  + crypto.randomBytes(4).toString('hex').toUpperCase(); }

function getDailySeed() {
  const d = new Date();
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}
function seededRng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0xFFFFFFFF; };
}
function generateCard(cardNum) {
  const rng = seededRng(getDailySeed() * 997 + cardNum * 31);
  return [[1,15],[16,30],[31,45],[46,60],[61,75]].map(([mn, mx]) => {
    const pool = Array.from({ length: mx - mn + 1 }, (_, i) => mn + i);
    const col  = [];
    while (col.length < 5) {
      const idx = Math.floor(rng() * pool.length);
      col.push(pool.splice(idx, 1)[0]);
    }
    return col;
  });
}
function getLetter(n) {
  if (n <= 15) return 'B';
  if (n <= 30) return 'I';
  if (n <= 45) return 'N';
  if (n <= 60) return 'G';
  return 'O';
}

// ══════════════════════════════════════════
//   HTTP AUTH MIDDLEWARE
// ══════════════════════════════════════════
function authMiddleware(req, res, next) {
  const token = req.headers['x-auth-token'];
  if (!token || !sessions.has(token))
    return res.status(401).json({ success: false, message: 'ያልተረጋገጠ' });
  req.phone = sessions.get(token);
  req.user  = users.get(req.phone);
  next();
}

// ══════════════════════════════════════════
//   ROOM CLASS
// ══════════════════════════════════════════
class Room {
  constructor(id, name, price, hostSocketId, hostName, hostPhone) {
    this.id             = id;
    this.name           = name;
    this.price          = price;
    this.hostSocketId   = hostSocketId;
    this.hostName       = hostName;
    this.hostPhone      = hostPhone;
    this.players        = [];       // { socketId, name, phone, cardNumber, marked, lines, linesSet }
    this.takenCards     = new Set();
    this.status         = 'waiting'; // waiting | running | finished
    this.calledNumbers  = [];
    this.calledOrder    = [];
    this.winners        = [];
    this.gameTimer      = null;
    this.countdownTimer = null;
    this.countdownActive = false;
    this.maxPlayers     = 100;
  }

  addPlayer(socketId, name, phone, cardNumber) {
    if (this.players.length >= this.maxPlayers)     return { ok: false, msg: 'ክፍሉ ሞልቷል' };
    if (this.takenCards.has(cardNumber))             return { ok: false, msg: 'ካርቴላ ተወስዷል' };
    if (this.players.find(p => p.socketId === socketId)) return { ok: false, msg: 'ቀድሞ ተቀላቅለዋል' };

    this.takenCards.add(cardNumber);
    const player = {
      socketId, name, phone, cardNumber,
      marked:   Array(5).fill(null).map(() => Array(5).fill(false)),
      lines:    0,
      linesSet: new Set()
    };
    player.marked[2][2] = true; // FREE center
    this.players.push(player);
    return { ok: true };
  }

  removePlayer(socketId) {
    const idx = this.players.findIndex(p => p.socketId === socketId);
    if (idx >= 0) {
      this.takenCards.delete(this.players[idx].cardNumber);
      this.players.splice(idx, 1);
    }
  }

  broadcast(event, data) {
    this.players.forEach(p => io.to(p.socketId).emit(event, data));
  }

  broadcastPlayersList() {
    const list = this.players.map(p => ({
      id: p.socketId, name: p.name, lines: p.lines, cardNumber: p.cardNumber
    }));
    this.broadcast('playersList', list);
  }

  startCountdown(seconds = 30) {
    if (this.countdownActive) return;
    this.countdownActive = true;
    let remaining = seconds;
    this.broadcast('countdown', { remaining });
    this.countdownTimer = setInterval(() => {
      remaining--;
      this.broadcast('countdown', { remaining });
      if (remaining <= 0) {
        clearInterval(this.countdownTimer);
        this.countdownTimer = null;
        this.startGame();
      }
    }, 1000);
  }

  startGame() {
    if (this.status !== 'waiting') return;
    if (this.players.length < 2) {
      this.broadcast('errorMessage', { message: 'ቢያንስ 2 ተጫዋቾች ያስፈልጋሉ' });
      return;
    }
    this.status = 'running';
    if (this.countdownTimer) { clearInterval(this.countdownTimer); this.countdownTimer = null; }

    this.calledNumbers = [];
    this.calledOrder   = [];
    this.winners       = [];

    this.players.forEach(p => {
      p.marked   = Array(5).fill(null).map(() => Array(5).fill(false));
      p.marked[2][2] = true;
      p.lines    = 0;
      p.linesSet = new Set();
      io.to(p.socketId).emit('gameStarted', {
        cardNumber: p.cardNumber,
        cardMatrix: generateCard(p.cardNumber)
      });
    });
    this.callNext();
  }

  callNext() {
    if (this.status !== 'running') return;
    if (this.calledNumbers.length >= 75) { this.endGame(null); return; }

    let num;
    do { num = Math.floor(Math.random() * 75) + 1; }
    while (this.calledNumbers.includes(num));

    this.calledNumbers.push(num);
    const letter = getLetter(num);
    this.calledOrder.push({ letter, number: num });

    this.broadcast('numberCalled', {
      letter, number: num, calledCount: this.calledNumbers.length
    });

    if (this.calledNumbers.length < 75) {
      this.gameTimer = setTimeout(() => this.callNext(), 3000);
    } else {
      setTimeout(() => this.endGame(null), 4000);
    }
  }

  markNumber(socketId, row, col) {
    const p = this.players.find(x => x.socketId === socketId);
    if (!p || this.status !== 'running') return;
    if (row < 0 || row > 4 || col < 0 || col > 4) return;
    const num = generateCard(p.cardNumber)[col][row];
    if (!this.calledNumbers.includes(num)) return;
    if (p.marked[row][col]) return;
    p.marked[row][col] = true;
    this.checkPlayerBingo(p);
  }

  checkPlayerBingo(player) {
    let newLine = false;
    for (let i = 0; i < 5; i++) {
      let rowC = true, colC = true;
      for (let j = 0; j < 5; j++) {
        if (!player.marked[i][j]) rowC = false;
        if (!player.marked[j][i]) colC = false;
      }
      if (rowC && !player.linesSet.has('r'+i)) { player.linesSet.add('r'+i); newLine = true; }
      if (colC && !player.linesSet.has('c'+i)) { player.linesSet.add('c'+i); newLine = true; }
    }
    let d1 = true, d2 = true;
    for (let i = 0; i < 5; i++) {
      if (!player.marked[i][i])     d1 = false;
      if (!player.marked[i][4-i])   d2 = false;
    }
    if (d1 && !player.linesSet.has('d0')) { player.linesSet.add('d0'); newLine = true; }
    if (d2 && !player.linesSet.has('d1')) { player.linesSet.add('d1'); newLine = true; }

    if (newLine) {
      player.lines = player.linesSet.size;
      io.to(player.socketId).emit('linesUpdate', { lines: player.lines });
      this.broadcastPlayersList();

      if (player.lines >= 2 && this.winners.length < 1) {
        const prize = Math.floor(this.players.length * this.price * 0.8);
        this.winners.push({ name: player.name, phone: player.phone });
        const u = users.get(player.phone);
        if (u) { u.balance += prize; u.wins = (u.wins || 0) + 1; }
        this.endGame({ winner: player.name, phone: player.phone, prize, players: this.players.length });
      }
    }
  }

  endGame(winnerData) {
    if (this.status === 'finished') return;
    this.status = 'finished';
    if (this.gameTimer)      { clearTimeout(this.gameTimer);    this.gameTimer      = null; }
    if (this.countdownTimer) { clearInterval(this.countdownTimer); this.countdownTimer = null; }
    this.broadcast('gameEnded', winnerData || { winner: null });
  }
}

// ══════════════════════════════════════════
//   AUTH API
// ══════════════════════════════════════════
app.post('/api/register', (req, res) => {
  const { name, phone, password, refCode } = req.body;
  if (!name || !phone || !password)
    return res.json({ success: false, message: 'ስም፣ ስልክ እና ፓስዎርድ ያስፈልጋል' });
  if (phone.length < 9)
    return res.json({ success: false, message: 'ስልክ ቁጥር ትክክል አይደለም' });
  if (users.has(phone))
    return res.json({ success: false, message: 'ይህ ስልክ ቀድሞ ተመዝግቷል' });

  const refCode2 = genRefCode();
  users.set(phone, {
    name, phone,
    password: hashPw(password),   // ← hashed now
    balance:  10,
    refCode:  refCode2,
    wins:     0,
    isAdmin:  false,
    withdrawPin: '1234'           // default PIN per user
  });

  if (refCode) {
    for (const u of users.values()) {
      if (u.refCode === refCode) { u.balance += 5; break; }
    }
  }

  const token = genToken();
  sessions.set(token, phone);
  res.json({ success: true, token, user: { name, phone, balance: 10, refCode: refCode2, wins: 0 } });
});

app.post('/api/login', (req, res) => {
  const { phone, password } = req.body;
  if (!phone || !password)
    return res.json({ success: false, message: 'ስልክ እና ፓስዎርድ ያስፈልጋል' });
  const user = users.get(phone);
  if (!user || user.password !== hashPw(password))
    return res.json({ success: false, message: 'ስልክ ወይም ፓስዎርድ ትክክል አይደለም' });
  const token = genToken();
  sessions.set(token, phone);
  res.json({ success: true, token, user: { name: user.name, phone: user.phone, balance: user.balance, refCode: user.refCode, wins: user.wins } });
});

app.get('/api/user/:phone', authMiddleware, (req, res) => {
  const u = users.get(req.params.phone);
  if (!u) return res.json({ success: false, message: 'ተጠቃሚ አልተገኘም' });
  res.json({ success: true, user: { name: u.name, phone: u.phone, balance: u.balance, refCode: u.refCode, wins: u.wins } });
});

// ══════════════════════════════════════════
//   WALLET API
// ══════════════════════════════════════════
app.post('/api/deposit', authMiddleware, (req, res) => {
  const { amount, reference } = req.body;
  if (!amount || amount < 100 || amount > 10000)
    return res.json({ success: false, message: 'ከ100-10,000 ብር ብቻ' });
  if (!reference)
    return res.json({ success: false, message: 'የክፍያ ማጣቀሻ ያስፈልጋል' });
  const id = genDepositId();
  deposits.set(id, { id, phone: req.phone, amount: parseFloat(amount), reference, status: 'pending', createdAt: Date.now() });
  res.json({ success: true, depositId: id, message: 'ጥያቄ ጠብቆ ነው። አስተዳዳሪ እስኪያረጋግጥ ይጠብቁ' });
});

app.get('/api/pending-deposits', (req, res) => {
  // Admin key checked server-side only — not exposed in frontend
  if (req.query.adminKey !== ADMIN_KEY)
    return res.status(403).json({ success: false, message: 'የተከለከለ' });
  const list = [...deposits.values()].filter(d => d.status === 'pending');
  res.json({ success: true, deposits: list });
});

app.post('/api/verify-deposit', (req, res) => {
  const { depositId, adminKey } = req.body;
  if (adminKey !== ADMIN_KEY)
    return res.status(403).json({ success: false, message: 'የተከለከለ' });
  const d = deposits.get(depositId);
  if (!d)                          return res.json({ success: false, message: 'ጥያቄ አልተገኘም' });
  if (d.status !== 'pending')      return res.json({ success: false, message: 'ቀድሞ ተረጋግጧል' });
  d.status = 'approved';
  const u = users.get(d.phone);
  if (u) u.balance += d.amount;
  res.json({ success: true, message: 'ተረጋግጧል', phone: d.phone, newBalance: u ? u.balance : 0 });
});

app.post('/api/withdraw', authMiddleware, (req, res) => {
  const { amount, withdrawPhone, pin } = req.body;
  const u = req.user;
  if (!amount || amount < 100)
    return res.json({ success: false, message: 'ዝቅተኛ 100 ብር' });
  if (pin !== (u.withdrawPin || '1234'))
    return res.json({ success: false, message: 'የተሳሳተ ፒን' });
  if (u.balance < amount)
    return res.json({ success: false, message: 'በቂ ገንዘብ የለም' });
  u.balance -= amount;
  withdrawals.push({ phone: req.phone, withdrawPhone: withdrawPhone || req.phone, amount: parseFloat(amount), status: 'pending', createdAt: Date.now() });
  res.json({ success: true, newBalance: u.balance, message: 'ጥያቄ ተልኳል' });
});

// ══════════════════════════════════════════
//   SOCKET.IO — REAL-TIME GAME
// ══════════════════════════════════════════
io.on('connection', (socket) => {
  console.log('🔌 connected:', socket.id);

  // ── STEP 1: Authenticate the socket ──────────────
  // Client sends token immediately after connect.
  // Server maps socketId → phone for all future events.
  socket.on('authenticate', ({ token }) => {
    const phone = sessions.get(token);
    if (phone) {
      socketToPhone.set(socket.id, phone);
      socket.emit('authenticated', { ok: true });
      console.log('✅ auth ok:', socket.id, '→', phone);
    } else {
      socket.emit('authenticated', { ok: false });
    }
  });

  // ── STEP 2: Join or Create Room (Auto-matchmaking) ──
  // Replaces old createRoom. If a waiting room at this price
  // already exists, joins it. Otherwise creates a new room.
  socket.on('joinOrCreateRoom', ({ price }) => {
    const phone = socketToPhone.get(socket.id);
    if (!phone) return socket.emit('errorMessage', { message: 'እባክዎ እንደገና ይግቡ' });

    const u = users.get(phone);
    if (!u) return socket.emit('errorMessage', { message: 'ተጠቃሚ አልተገኘም' });
    if (u.balance < price) return socket.emit('errorMessage', { message: 'በቂ ገንዘብ የለም — ዲፖዚት ያድርጉ' });

    // Find an open waiting room at this price
    let targetRoom = null;
    for (const room of rooms.values()) {
      if (room.price === price && room.status === 'waiting' && room.players.length < room.maxPlayers) {
        targetRoom = room;
        break;
      }
    }

    if (!targetRoom) {
      // Create brand-new room — this player is host
      const id       = genRoomId();
      const roomName = price + ' ብር';
      targetRoom = new Room(id, roomName, price, socket.id, u.name, phone);
      rooms.set(id, targetRoom);
      socket.join(id);
      socket.emit('roomCreated', {
        roomId: id, roomName, price, isHost: true, takenCards: []
      });
    } else {
      // Join existing room
      socket.join(targetRoom.id);
      socket.emit('roomJoined', {                           // ← was never emitted before
        roomId:     targetRoom.id,
        roomName:   targetRoom.name,
        price:      targetRoom.price,
        isHost:     false,
        takenCards: Array.from(targetRoom.takenCards)
      });
    }
  });

  // ── STEP 3: Select card ──────────────────────────
  // BUG FIX: was using room.hostPhone (always host's user).
  // Now uses socketToPhone to get the CORRECT player.
  socket.on('selectCard', ({ roomId, cardNumber }) => {
    const phone = socketToPhone.get(socket.id);            // ← correct player
    if (!phone) return socket.emit('errorMessage', { message: 'እባክዎ እንደገና ይግቡ' });

    const u = users.get(phone);
    if (!u) return socket.emit('errorMessage', { message: 'ተጠቃሚ አልተገኘም' });

    const room = rooms.get(roomId);
    if (!room)                       return socket.emit('errorMessage', { message: 'ክፍል አልተገኘም' });
    if (room.status !== 'waiting')   return socket.emit('errorMessage', { message: 'ጨዋታ ጀምሯል' });
    if (u.balance < room.price)      return socket.emit('errorMessage', { message: 'በቂ ገንዘብ የለም' });

    socket.join(roomId);                                   // ← player 2 must join the IO room

    const result = room.addPlayer(socket.id, u.name, phone, cardNumber);
    if (!result.ok) return socket.emit('errorMessage', { message: result.msg });

    u.balance -= room.price;                               // ← deducts from CORRECT player

    room.broadcastPlayersList();
    socket.emit('cardConfirmed', { cardNumber });
    io.to(roomId).emit('takenUpdate', {
      taken: Array.from(room.takenCards),
      playerCount: room.players.length
    });

    // Auto-start countdown when 2+ players have selected cards
    if (room.players.length >= 2 && !room.countdownActive) {
      room.startCountdown(30);
    }
  });

  // ── In-game events ───────────────────────────────
  socket.on('markNumber', ({ roomId, row, col }) => {
    const room = rooms.get(roomId);
    if (room) room.markNumber(socket.id, row, col);
  });

  socket.on('claimBingo', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const p = room.players.find(x => x.socketId === socket.id);
    if (p) room.checkPlayerBingo(p);
  });

  socket.on('startGame', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (room && room.hostSocketId === socket.id) {
      room.startGame();
    }
  });

  socket.on('leaveRoom', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    room.removePlayer(socket.id);
    socket.leave(roomId);
    if (room.players.length === 0) rooms.delete(roomId);
    else room.broadcastPlayersList();
  });

  socket.on('disconnect', () => {
    console.log('❌ disconnected:', socket.id);
    socketToPhone.delete(socket.id);   // ← cleanup mapping
    for (const room of rooms.values()) {
      if (room.players.find(x => x.socketId === socket.id)) {
        room.removePlayer(socket.id);
        if (room.players.length === 0) rooms.delete(room.id);
        else room.broadcastPlayersList();
        break;
      }
    }
  });
});

// ══════════════════════════════════════════
//   START
// ══════════════════════════════════════════
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎯 ULTRA BINGO running on port ${PORT}`);
  console.log(`📡 Open: http://localhost:${PORT}`);
});
