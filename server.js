const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// ==================== ውሂብ ማከማቻ ====================
const users = new Map();
const rooms = new Map();
const usedReferences = new Set();
const pendingDeposits = new Map();

// ==================== ረዳት ተግባራት ====================
function generateRefCode() {
  return 'UB' + Math.random().toString(36).substring(2, 10).toUpperCase();
}

function getLetter(num) {
  if (num <= 15) return "B";
  if (num <= 30) return "I";
  if (num <= 45) return "N";
  if (num <= 60) return "G";
  return "O";
}

function generateRandomNumberPool() {
  let numbers = Array.from({ length: 75 }, (_, i) => i + 1);
  for (let i = numbers.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [numbers[i], numbers[j]] = [numbers[j], numbers[i]];
  }
  return numbers;
}

function generateBingoCard() {
  const card = [];
  const ranges = [[1, 15], [16, 30], [31, 45], [46, 60], [61, 75]];
  for (const [min, max] of ranges) {
    const numbers = [];
    const available = Array.from({ length: max - min + 1 }, (_, i) => min + i);
    for (let i = 0; i < 5; i++) {
      const randomIndex = Math.floor(Math.random() * available.length);
      numbers.push(available[randomIndex]);
      available.splice(randomIndex, 1);
    }
    card.push(numbers);
  }
  return card;
}

function calculateLines(card, marked) {
  let lines = 0;
  for (let row = 0; row < 5; row++) {
    let complete = true;
    for (let col = 0; col < 5; col++) if (!marked[row][col]) { complete = false; break; }
    if (complete) lines++;
  }
  for (let col = 0; col < 5; col++) {
    let complete = true;
    for (let row = 0; row < 5; row++) if (!marked[row][col]) { complete = false; break; }
    if (complete) lines++;
  }
  let diag1 = true, diag2 = true;
  for (let i = 0; i < 5; i++) {
    if (!marked[i][i]) diag1 = false;
    if (!marked[i][4 - i]) diag2 = false;
  }
  if (diag1) lines++;
  if (diag2) lines++;
  return lines;
}

// ==================== ኤፒአይ ኢንድፖይንቶች ====================

app.post('/api/register', (req, res) => {
  const { name, phone, refCode } = req.body;
  if (!name || !phone) return res.json({ success: false, message: 'ስም እና ስልክ ያስፈልጋል' });
  if (users.has(phone)) return res.json({ success: false, message: 'ይህ ስልክ ቀድሞ ተመዝግቧል' });
  
  let bonus = 10;
  let referredByName = null;
  if (refCode) {
    for (const [existingPhone, existingUser] of users.entries()) {
      if (existingUser.refCode === refCode) {
        referredByName = existingUser.name;
        existingUser.balance += 5;
        existingUser.referredUsers.push({ name, phone, date: new Date().toISOString() });
        users.set(existingPhone, existingUser);
        bonus += 5;
        break;
      }
    }
  }
  
  const newUser = {
    name, phone, balance: bonus, bonusPending: true, bonusClaimed: false,
    totalDeposited: 0, refCode: generateRefCode(), referredBy: refCode || null,
    referredByName, referredUsers: [], depositHistory: [], withdrawHistory: [],
    wins: 0, createdAt: new Date().toISOString()
  };
  users.set(phone, newUser);
  res.json({ success: true, message: 'ተመዝግበዋል', user: { name, phone, balance: newUser.balance, refCode: newUser.refCode } });
});

app.post('/api/deposit', (req, res) => {
  const { phone, amount, reference } = req.body;
  const user = users.get(phone);
  if (!user) return res.json({ success: false, message: 'ተጠቃሚ አልተገኘም' });
  if (amount < 100 || amount > 10000) return res.json({ success: false, message: 'ዲፖዚት ከ100 እስከ 10,000 ብር መሆን አለበት' });
  if (!reference || reference.trim() === '') return res.json({ success: false, message: 'እባክዎ የቴሌብር ማጣቀሻ ቁጥር ያስገቡ' });
  if (usedReferences.has(reference)) return res.json({ success: false, message: 'ይህ ማጣቀሻ ቁጥር ቀድሞ ጥቅም ላይ ውሏል' });
  
  const depositId = 'DEP_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
  pendingDeposits.set(depositId, { phone, amount, reference, status: 'pending', date: new Date().toISOString() });
  res.json({ success: true, message: 'ዲፖዚት ጥያቄ ተልኳል። ከተረጋገጠ በኋላ ሂሳብዎ ይዘመናል', depositId });
});

// ✅ አስተዳዳሪ ቁልፉ 8084877485 ሆኖ ተቀምጧል
app.post('/api/verify-deposit', (req, res) => {
  const { depositId, adminKey } = req.body;
  if (adminKey !== '8084877485') return res.json({ success: false, message: 'ያልተፈቀደ' });
  const pending = pendingDeposits.get(depositId);
  if (!pending) return res.json({ success: false, message: 'ጥያቄ አልተገኘም' });
  if (pending.status !== 'pending') return res.json({ success: false, message: 'ይህ ጥያቄ ቀድሞ ተፈትቷል' });
  
  const user = users.get(pending.phone);
  if (!user) return res.json({ success: false, message: 'ተጠቃሚ አልተገኘም' });
  
  user.balance += pending.amount;
  user.totalDeposited += pending.amount;
  user.depositHistory.push({ amount: pending.amount, reference: pending.reference, date: pending.date, status: 'completed' });
  usedReferences.add(pending.reference);
  
  users.set(pending.phone, user);
  pending.status = 'completed';
  pendingDeposits.set(depositId, pending);
  res.json({ success: true, message: 'ዲፖዚት ተረጋግጧል', newBalance: user.balance, phone: pending.phone });
});

app.get('/api/user/:phone', (req, res) => {
  const user = users.get(req.params.phone);
  if (!user) return res.json({ success: false });
  res.json({ success: true, user: { name: user.name, balance: user.balance, refCode: user.refCode, totalDeposited: user.totalDeposited, wins: user.wins } });
});

app.get('/api/pending-deposits', (req, res) => {
  const { adminKey } = req.query;
  if (adminKey !== '8084877485') return res.json({ success: false });
  const list = Array.from(pendingDeposits.entries()).map(([id, data]) => ({ id, ...data }));
  res.json({ success: true, deposits: list });
});

app.post('/api/withdraw', (req, res) => {
  const { phone, amount, pin, withdrawPhone } = req.body;
  const user = users.get(phone);
  if (!user) return res.json({ success: false, message: 'ተጠቃሚ አልተገኘም' });
  if (amount < 100 || amount > 10000) return res.json({ success: false, message: 'ከ100 እስከ 10,000 ብር' });
  if (pin !== '1234') return res.json({ success: false, message: 'የደህንነት ፒን ትክክል አይደለም' });
  if (user.totalDeposited < 100) return res.json({ success: false, message: 'ገንዘብ ለማውጣት ቢያንስ 100 ብር ማስገባት አለብዎት' });
  if (user.balance < amount) return res.json({ success: false, message: 'በቂ ገንዘብ የለም' });
  
  user.balance -= amount;
  user.withdrawHistory.push({ amount, phone: withdrawPhone, date: new Date().toISOString(), status: 'pending' });
  users.set(phone, user);
  res.json({ success: true, message: 'የዊዝድሮ ጥያቄ ተልኳል', newBalance: user.balance });
});

// ==================== ሶኬት ክስተቶች ====================
io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);
  
  socket.on('createRoom', (data) => {
    const { playerName, phone } = data;
    const user = users.get(phone);
    if (!user) { socket.emit('errorMessage', { message: 'ተጠቃሚ አልተገኘም' }); return; }
    const roomId = `room_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`;
    const room = {
      id: roomId, players: new Map(), gameActive: false, calledNumbers: [],
      numberPool: null, winner: null, hostId: socket.id, hostName: playerName, interval: null
    };
    room.players.set(socket.id, { id: socket.id, name: playerName, phone, card: null, marked: null, lines: 0 });
    rooms.set(roomId, room);
    socket.join(roomId);
    socket.emit('roomCreated', { roomId, isHost: true });
    io.to(roomId).emit('playersList', Array.from(room.players.values()).map(p => ({ id: p.id, name: p.name })));
  });
  
  socket.on('joinRoom', (data) => {
    const { roomId, playerName, phone } = data;
    const room = rooms.get(roomId);
    const user = users.get(phone);
    if (!room) { socket.emit('errorMessage', { message: 'ክፍል አልተገኘም' }); return; }
    if (!user) { socket.emit('errorMessage', { message: 'ተጠቃሚ አልተገኘም' }); return; }
    if (room.gameActive) { socket.emit('errorMessage', { message: 'ጨዋታ ተጀምሯል' }); return; }
    const newCard = generateBingoCard();
    const newMarked = Array(5).fill().map(() => Array(5).fill(false));
    newMarked[2][2] = true;
    room.players.set(socket.id, { id: socket.id, name: playerName, phone, card: newCard, marked: newMarked, lines: 0 });
    socket.join(roomId);
    socket.emit('roomJoined', { roomId, isHost: socket.id === room.hostId });
    socket.emit('cardData', { card: newCard });
    io.to(roomId).emit('playersList', Array.from(room.players.values()).map(p => ({ id: p.id, name: p.name })));
  });
  
  socket.on('startGame', (data) => {
    const { roomId } = data;
    const room = rooms.get(roomId);
    if (!room || socket.id !== room.hostId) { socket.emit('errorMessage', { message: 'አስተናጋጁ ብቻ መጀመር ይችላል' }); return; }
    if (room.players.size < 2) { socket.emit('errorMessage', { message: 'ቢያንስ 2 ተጫዋቾች ያስፈልጋሉ' }); return; }
    room.gameActive = true;
    room.calledNumbers = [];
    room.numberPool = generateRandomNumberPool();
    room.winner = null;
    for (let [playerId, player] of room.players.entries()) {
      const newCard = generateBingoCard();
      const newMarked = Array(5).fill().map(() => Array(5).fill(false));
      newMarked[2][2] = true;
      player.card = newCard;
      player.marked = newMarked;
      player.lines = 0;
      room.players.set(playerId, player);
      io.to(playerId).emit('cardData', { card: newCard });
    }
    io.to(roomId).emit('gameStarted');
    startNumberCalling(roomId);
  });
  
  socket.on('markNumber', (data) => {
    const { roomId, row, col, number } = data;
    const room = rooms.get(roomId);
    if (!room || !room.gameActive) return;
    const player = room.players.get(socket.id);
    if (!player) return;
    if (player.card[col][row] !== number) return;
    if (!room.calledNumbers.includes(number)) { socket.emit('errorMessage', { message: 'ቁጥሩ ገና አልወጣም' }); return; }
    player.marked[row][col] = true;
    const lines = calculateLines(player.card, player.marked);
    player.lines = lines;
    room.players.set(socket.id, player);
    io.to(socket.id).emit('linesUpdate', { lines });
    if (lines >= 2 && !room.winner) {
      const user = users.get(player.phone);
      if (user) { user.wins = (user.wins || 0) + 1; users.set(player.phone, user); }
      room.winner = { id: socket.id, name: player.name };
      room.gameActive = false;
      if (room.interval) clearInterval(room.interval);
      io.to(roomId).emit('gameEnded', { winner: player.name });
    }
  });
  
  socket.on('claimBingo', (data) => {
    const { roomId } = data;
    const room = rooms.get(roomId);
    if (!room || !room.gameActive) return;
    const player = room.players.get(socket.id);
    if (!player) return;
    if (player.lines >= 2 && !room.winner) {
      const user = users.get(player.phone);
      if (user) { user.wins = (user.wins || 0) + 1; users.set(player.phone, user); }
      room.winner = { id: socket.id, name: player.name };
      room.gameActive = false;
      if (room.interval) clearInterval(room.interval);
      io.to(roomId).emit('gameEnded', { winner: player.name });
    } else {
      socket.emit('errorMessage', { message: `እስካሁን ${player.lines} መስመር ብቻ! 2 ያስፈልጋል` });
    }
  });
  
  socket.on('leaveRoom', (data) => {
    const { roomId } = data;
    const room = rooms.get(roomId);
    if (room) {
      room.players.delete(socket.id);
      socket.leave(roomId);
      if (room.players.size === 0) { if (room.interval) clearInterval(room.interval); rooms.delete(roomId); }
      else { io.to(roomId).emit('playersList', Array.from(room.players.values()).map(p => ({ id: p.id, name: p.name }))); }
    }
  });
  
  socket.on('disconnect', () => {
    for (const [roomId, room] of rooms.entries()) {
      if (room.players.has(socket.id)) {
        room.players.delete(socket.id);
        if (room.players.size === 0) { if (room.interval) clearInterval(room.interval); rooms.delete(roomId); }
        else { io.to(roomId).emit('playersList', Array.from(room.players.values()).map(p => ({ id: p.id, name: p.name }))); }
        break;
      }
    }
  });
});

function startNumberCalling(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  room.interval = setInterval(() => {
    const currentRoom = rooms.get(roomId);
    if (!currentRoom || !currentRoom.gameActive || currentRoom.winner) {
      if (currentRoom && currentRoom.interval) clearInterval(currentRoom.interval);
      return;
    }
    if (currentRoom.numberPool.length === 0) {
      io.to(roomId).emit('gameEnded', { winner: null, message: 'ሁሉም ቁጥሮች ተጠርተዋል' });
      currentRoom.gameActive = false;
      if (currentRoom.interval) clearInterval(currentRoom.interval);
      return;
    }
    const number = currentRoom.numberPool.shift();
    const letter = getLetter(number);
    currentRoom.calledNumbers.push(number);
    io.to(roomId).emit('numberCalled', { number, letter, calledCount: currentRoom.calledNumbers.length });
  }, 3000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Ultra Bingo Server running on port ${PORT}`);
  console.log(`📞 Deposit Number: 0953025980 (Seid)`);
  console.log(`🔑 Admin Key: 8084877485`);
});